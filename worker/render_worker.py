#!/usr/bin/env python3
"""Video worker: the hands of the youtube channel.

Polls Supabase for approved video activities whose avatar clips are ready but
whose finished file is missing, then: downloads clips, renders the queued
slides (worker/slides.py, headless Chromium), transcribes for captions,
composites (on-camera blocks full frame, slide blocks with the avatar bubble,
karaoke, music) via scripts/render-video-from-plan.py, uploads the mp4 to
Storage, and points the activity at it. The publish cron uploads it to
YouTube from there.

One replica only. A claim stamp (content_meta.worker_claim_at) keeps a second
replica — or a restart mid-render — from doubling paid work; stale claims
(>30 min) are picked back up.

Env:
  SUPABASE_URL, SUPABASE_SERVICE_KEY (service role: reads vault-adjacent rows,
    never the encrypted keys themselves — the worker needs no secrets),
  STORAGE_BUCKET (default persona-videos, must exist and be public),
  POLL_SECONDS (default 300), WHISPER_MODEL (default small),
  RENDER_SCRIPT (default /app/scripts/render-video-from-plan.py),
  WORK_DIR (default /tmp/video-worker).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Stdlib-only at import time; Chromium loads inside render_slides.
from slides import SlideSpecError

STALE_CLAIM_MINUTES = 30
MAX_ATTEMPTS = 3
RETRY_MINUTES = 10
PREVIEW_MAX_TRIES = 5
CLAIMABLE_STATUSES = ["approved", "scheduled", "publishing", "draft"]


def log(*parts: object) -> None:
    print(datetime.now(timezone.utc).isoformat(), *parts, flush=True)


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} {' '.join(cmd[1:4])} failed: {r.stderr[-600:]}")


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "seo-copilot-worker/1.0"})
    with urllib.request.urlopen(req, timeout=120) as res, open(dest, "wb") as f:
        f.write(res.read())


def worker_visuals(meta: dict, clip_count: int) -> list | None:
    """One visual per clip: None films the avatar full frame, a dict is a slide.
    content_meta.visuals is one per block; older drafts carry slides, one per
    body block with the first block on camera."""
    visuals = meta.get("visuals")
    if isinstance(visuals, list):
        return visuals if len(visuals) == clip_count else None
    slides = meta.get("slides")
    if isinstance(slides, list) and len(slides) == clip_count - 1:
        return [None, *slides]
    return None


def main() -> None:
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    bucket = os.getenv("STORAGE_BUCKET", "persona-videos")
    poll = int(os.getenv("POLL_SECONDS", "300"))
    model_name = os.getenv("WHISPER_MODEL", "small")
    render_script = os.getenv("RENDER_SCRIPT", "/app/scripts/render-video-from-plan.py")
    work_root = Path(os.getenv("WORK_DIR", "/tmp/video-worker"))
    work_root.mkdir(parents=True, exist_ok=True)
    client = create_client(url, key)
    log("worker up, polling every", poll, "s")

    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    log("whisper ready:", model_name)

    while True:
        try:
            job = claim_job(client)
            if job:
                try:
                    run_job(client, model, job, bucket, render_script, work_root)
                except Exception:
                    # run_job records the failure, then re-raises so a failed
                    # job backs off here — otherwise it re-claims at once and
                    # spins select/update against Supabase.
                    time.sleep(60)
            else:
                # Idle: draw the slides of drafts waiting for review, so the
                # reviewer sees them before any HeyGen credit is spent.
                preview_pass(client, bucket, work_root)
                time.sleep(poll)
        except Exception as exc:  # never die on a bad job; the loop is the service
            log("loop error:", exc)
            traceback.print_exc()
            time.sleep(60)


def preview_fingerprint(visuals: list) -> str:
    return hashlib.sha256(json.dumps(visuals, sort_keys=True).encode()).hexdigest()[:16]


def channel_site(client, channel_id) -> str:
    chan = (
        client.table("persona_channels")
        .select("channel_config")
        .eq("id", channel_id)
        .maybe_single()
        .execute()
    )
    # maybe_single() can hand back None instead of an empty result.
    data = (chan.data if chan else None) or {}
    return site_label(data.get("channel_config") or {})


def site_label(cfg: dict) -> str:
    """The slide footer: the channel's site as a bare domain, or nothing. Never
    another persona's site: an empty setting leaves the footer off."""
    raw = str(cfg.get("youtube_site_url") or "").strip()
    return re.sub(r"^https?://(www\.)?", "", raw).rstrip("/")


def preview_pass(client, bucket: str, work_root: Path, render=None) -> int:
    """Render slide previews for video drafts still in review. Only drafts:
    once approved, the publish cron owns content_meta and a second writer
    could clobber its clip ids. Returns how many drafts were rendered."""
    res = (
        client.table("persona_activities")
        .select("id,persona_id,channel_id,content_meta")
        .eq("kind", "video")
        .eq("status", "draft")
        .execute()
    )
    rendered = 0
    for row in res.data or []:
        meta = row.get("content_meta") or {}
        blocks = meta.get("blocks")
        visuals = worker_visuals(meta, len(blocks)) if isinstance(blocks, list) else None
        if not visuals:
            continue
        fp = preview_fingerprint(visuals)
        # slide_previews_for is only written once the attempt is settled: a
        # render, a bad spec, or transient failures out of retries.
        if meta.get("slide_previews_for") == fp:
            continue
        render_previews(client, row, visuals, fp, bucket, work_root, render)
        rendered += 1
    return rendered


def render_previews(client, row: dict, visuals: list, fp: str, bucket: str, work_root: Path, render=None) -> None:
    aid, pid = row["id"], row["persona_id"]
    Path(work_root).mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="vprev-", dir=str(work_root)))
    urls: list = [None] * len(visuals)
    error = None
    settled = True
    try:
        if render is None:
            from slides import render_slides as render  # Chromium: loaded only when needed
        pngs = render(visuals, channel_site(client, row["channel_id"]), work)
        for i, png in enumerate(pngs):
            if png is None:
                continue
            # The fingerprint in the path: an edited draft gets new URLs, never a cached old slide.
            path = f"{pid}/previews/{aid}/{fp}/slide{i}.png"
            with open(png, "rb") as f:
                client.storage.from_(bucket).upload(path, f, {"content-type": "image/png", "upsert": "true"})
            urls[i] = client.storage.from_(bucket).get_public_url(path)
        log("preview ok", aid)
    except SlideSpecError as exc:
        # A malformed slide spec: the same input fails the same way, so record it once.
        # Any other ValueError (a decode error in a storage response) is transient.
        error = str(exc)[:300]
        log("preview refused", aid, error)
    except Exception as exc:  # Chromium, storage, network: worth another try
        error = str(exc)[:300]
        log("preview failed", aid, error)
        tries = (row.get("content_meta") or {}).get("slide_previews_try") or {}
        n = int(tries.get("n") or 0) + 1 if tries.get("fp") == fp else 1
        settled = n >= PREVIEW_MAX_TRIES
    finally:
        shutil.rmtree(work, ignore_errors=True)
    # Merge into a fresh read: the reviewer may have edited the draft while
    # the slides rendered, and a stale whole-row write would undo that.
    fresh = client.table("persona_activities").select("content_meta").eq("id", aid).maybe_single().execute()
    meta = dict(((fresh.data if fresh else None) or {}).get("content_meta") or {})
    # This attempt's images, even when empty: an old slide next to a new error misleads.
    meta["slide_previews"] = urls
    if error:
        meta["slide_previews_error"] = error
    else:
        meta.pop("slide_previews_error", None)
    if settled:
        meta["slide_previews_for"] = fp
        meta.pop("slide_previews_try", None)
    else:
        meta["slide_previews_try"] = {"fp": fp, "n": n}
    client.table("persona_activities").update({"content_meta": meta}).eq("id", aid).execute()


def claim_job(client, table=None):
    """Oldest approved video with clips but no finished file, unclaimed."""
    res = (
        client.table("persona_activities")
        .select("id,persona_id,channel_id,title,content_meta")
        .eq("kind", "video")
        # "publishing" rows carrying finished HeyGen clips are the publish
        # cron's parked leftovers; "draft" rows with clips are previews
        # someone asked to watch. The stage == "clips_ready" + no-final_url
        # gate below keeps the worker away from anything still in flight.
        .in_("status", CLAIMABLE_STATUSES)
        .execute()
    )
    now = datetime.now(timezone.utc)
    cands = []
    for row in res.data or []:
        meta = row.get("content_meta") or {}
        if meta.get("stage") != "clips_ready" or meta.get("final_url"):
            continue
        if meta.get("worker_failed_at"):
            # Out of attempts: the row is marked failed with the error, and a
            # person re-approving it clears this and sends it back here.
            continue
        retry_at = meta.get("worker_retry_at")
        if retry_at:
            try:
                if datetime.fromisoformat(retry_at) > now:
                    continue
            except ValueError:
                pass
        if not isinstance(meta.get("video_urls"), list) or not meta["video_urls"]:
            continue
        claimed = meta.get("worker_claim_at")
        if claimed:
            try:
                if now - datetime.fromisoformat(claimed) < timedelta(minutes=STALE_CLAIM_MINUTES):
                    continue
            except ValueError:
                pass
        cands.append(row)
    if not cands:
        return None
    job = cands[0]
    meta = dict(job["content_meta"] or {})
    meta.pop("worker_retry_at", None)
    meta["worker_claim_at"] = now.isoformat()
    client.table("persona_activities").update({"content_meta": meta}).eq("id", job["id"]).execute()
    job["content_meta"] = meta
    return job


def fail_job(client, job: dict, message: str) -> None:
    """Record a failed composite. Early failures retry later and further apart,
    since most are transient (a download timeout, an upload error). The last
    one marks the row failed with the error, where the review queue shows it;
    re-approving it there is the retry."""
    meta = dict(job.get("content_meta") or {})
    meta.pop("worker_claim_at", None)
    meta["worker_error"] = message[:500]
    attempts = int(meta.get("worker_attempts") or 0) + 1
    meta["worker_attempts"] = attempts
    now = datetime.now(timezone.utc)
    patch: dict = {"content_meta": meta}
    if attempts >= MAX_ATTEMPTS:
        meta["worker_failed_at"] = now.isoformat()
        meta.pop("render_requested", None)  # no longer in flight; the queue offers the retry
        patch["status"] = "failed"
        patch["error"] = f"Video composite failed {attempts} times: {message}"[:500]
    else:
        meta["worker_retry_at"] = (now + timedelta(minutes=RETRY_MINUTES * attempts)).isoformat()
    # Same guard as finish_job: a row discarded mid-composite keeps its status
    # and only gets the error recorded.
    moved = (
        client.table("persona_activities")
        .update(patch)
        .eq("id", job["id"])
        .in_("status", CLAIMABLE_STATUSES)
        .execute()
    )
    if not moved.data:
        client.table("persona_activities").update({"content_meta": meta}).eq("id", job["id"]).execute()


def finish_job(client, aid, meta: dict) -> bool:
    """Record the finished video and send it back to the review queue, where a
    person watches it and approving it is what uploads it. Only while the row
    is still where the worker found it: a reviewer may have discarded it during
    the composite, and bringing it back would put a discarded video one click
    from YouTube. Returns whether it went back to the queue."""
    meta["stage"] = "ready"
    meta.pop("worker_claim_at", None)
    meta.pop("worker_error", None)
    meta.pop("render_requested", None)
    moved = (
        client.table("persona_activities")
        .update({"content_meta": meta, "status": "draft"})
        .eq("id", aid)
        .in_("status", CLAIMABLE_STATUSES)
        .execute()
    )
    if moved.data:
        return True
    # It moved on: keep the finished file on it, leave its status alone.
    client.table("persona_activities").update({"content_meta": meta}).eq("id", aid).execute()
    return False


def run_job(client, model, job: dict, bucket: str, render_script: str, work_root: Path) -> None:
    aid, pid = job["id"], job["persona_id"]
    log("job", aid)
    Path(work_root).mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="vjob-", dir=str(work_root)))
    try:
        meta = dict(job.get("content_meta") or {})
        clips: list[str] = [u for u in meta.get("video_urls", []) if isinstance(u, str) and u]
        visuals = worker_visuals(meta, len(clips))
        if visuals is None:
            # Anything but one visual per clip is a malformed draft the agent
            # validator should have refused. Raise, don't return: the except
            # below records it once and the loop backs off like any failure.
            raise RuntimeError(f"slides_mismatch: visuals do not pair one per clip ({len(clips)} clips)")

        chan = (
            client.table("persona_channels")
            .select("channel_config")
            .eq("id", job["channel_id"])
            .maybe_single()
            .execute()
        )
        cfg = ((chan.data or {}).get("channel_config")) or {}
        site = site_label(cfg)
        music = cfg.get("youtube_music_url")

        clip_paths = []
        for i, cu in enumerate(clips):
            p = work / f"clip{i}.mp4"
            download(cu, p)
            clip_paths.append(str(p))

        # Voice track for captions: MP4s carry per-file indexes, so byte-level
        # concat would silently keep only the first clip — use the demuxer.
        wav = work / "voice.wav"
        voice_list = work / "voice-concat.txt"
        voice_list.write_text("".join(f"file '{p}'\n" for p in clip_paths))
        run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
             "-i", str(voice_list), "-ar", "16000", "-ac", "1",
             "-c:a", "pcm_s16le", str(wav)])
        segments, _ = model.transcribe(str(wav), language="en", word_timestamps=True)
        segments = list(segments)
        srt_lines = []
        words = []
        for n, s in enumerate(segments, 1):
            srt_lines.append(f"{n}\n{ts(s.start)} --> {ts(s.end)}\n{s.text.strip()}\n")
            for w in s.words or []:
                words.append({"w": w.word, "s": round(w.start, 2), "e": round(w.end, 2)})
        srt = work / "caps.srt"
        srt.write_text("\n".join(srt_lines))
        words_json = work / "words.json"
        words_json.write_text(json.dumps(words))

        from slides import render_slides  # Chromium: loaded only when a job runs

        slide_pngs = render_slides(visuals, site, work)

        def dur(p: str) -> float:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                                "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", p],
                               capture_output=True, text=True, check=True)
            return round(float(r.stdout.strip()), 2)

        plan = {
            "version": 1,
            "segments": [
                {"kind": "face", "avatarMp4": cp, "durationSeconds": dur(cp)}
                if png is None
                else {"kind": "slide", "slidePng": str(png), "avatarMp4": cp, "durationSeconds": dur(cp)}
                for png, cp in zip(slide_pngs, clip_paths)
            ],
            "musicMp3": None,
            "musicLevel": 0.06,
            "captionsSrt": str(srt),
            "wordsJson": str(words_json),
            "outputMp4": str(work / "final.mp4"),
        }
        music_path = None
        if isinstance(music, str) and music.startswith("http"):
            music_path = work / "music.mp3"
            download(music, music_path)
            plan["musicMp3"] = str(music_path)
        plan_file = work / "plan.json"
        plan_file.write_text(json.dumps(plan))
        render_font = os.getenv(
            "WORKER_RENDER_FONT",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        )
        run([sys.executable, render_script, str(plan_file),
             "--font", render_font,
             "--workdir", str(work / "render")])

        final = work / "final-captioned-music.mp4"
        if not final.exists():
            final = work / "final-captioned.mp4"
        if not final.exists():
            final = work / "final.mp4"
        storage_path = f"{pid}/{aid}.mp4"
        with open(final, "rb") as f:
            client.storage.from_(bucket).upload(storage_path, f,
                                                {"content-type": "video/mp4", "upsert": "true"})
        public_url = client.storage.from_(bucket).get_public_url(storage_path)

        meta["final_url"] = public_url
        finish_job(client, aid, meta)
        log("job done", aid, public_url)
    except Exception as exc:
        log("job failed", aid, exc)
        traceback.print_exc()
        fail_job(client, job, str(exc))
        # Re-raise so the loop backs off: without this the failure is
        # recorded but invisible to main, and the row re-claims at once.
        raise
    finally:
        # Every run leaves clips, wavs, PNGs and full renders behind — tens of
        # MB per video. Clean the scratch dir or the disk fills in weeks.
        shutil.rmtree(work, ignore_errors=True)


def ts(s: float) -> str:
    h, r = divmod(int(s), 3600)
    m, sec = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{sec:02d},{int((s % 1) * 1000):03d}"


if __name__ == "__main__":
    main()
