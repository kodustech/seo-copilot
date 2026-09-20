#!/usr/bin/env python3
"""Video worker: the hands of the youtube channel.

Polls Supabase for approved video activities whose avatar clips are ready but
whose finished file is missing, then: downloads clips, renders slides from
the queued outlines, transcribes for captions, composites (intro + bubble +
karaoke + music) via scripts/render-video-from-plan.py, uploads the mp4 to
Storage, and points the activity at it. The publish cron takes it from there
(unlisted YouTube upload).

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
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

STALE_CLAIM_MINUTES = 30
MAX_ATTEMPTS = 3

FONT_BOLD = os.getenv("WORKER_FONT_BOLD", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
FONT_MONO = os.getenv("WORKER_FONT_MONO", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")


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


def render_slide(spec: dict, site: str, dest: Path) -> None:
    """Deterministic channel template: dark, mono rows, accent note."""
    from PIL import Image, ImageDraw, ImageFont

    bg, white, gray, acc, green = (15, 15, 35), (255, 255, 255), (150, 150, 170), (139, 92, 246), (52, 211, 153)
    img = Image.new("RGB", (1920, 1080), bg)
    dr = ImageDraw.Draw(img)
    title_f = ImageFont.truetype(FONT_BOLD, 72)
    mono_f = ImageFont.truetype(FONT_MONO, 40)
    small_f = ImageFont.truetype(FONT_BOLD, 30)
    note_f = ImageFont.truetype(FONT_BOLD, 36)
    dr.rectangle([0, 0, 1920, 10], fill=acc)
    y = 120
    for line in spec["title"].split("\n"):
        dr.text((80, y), line, font=title_f, fill=white)
        y += 95
    y = max(y + 40, 380)
    for row in spec["rows"][:6]:
        dr.text((120, y), "> " + row, font=mono_f, fill=white)
        y += 90
    if spec.get("note"):
        dr.text((80, 880), spec["note"], font=note_f, fill=acc)
    dr.text((80, 1020), site, font=small_f, fill=gray)
    img.save(dest)
    log("slide ok", Path(dest).name)


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
                    # run_job records its own failures and returns normally, so
                    # a failed job must back off here — otherwise it re-claims
                    # at once and spins select/update against Supabase.
                    time.sleep(60)
            else:
                time.sleep(poll)
        except Exception as exc:  # never die on a bad job; the loop is the service
            log("loop error:", exc)
            traceback.print_exc()
            time.sleep(60)


def claim_job(client, table=None):
    """Oldest approved video with clips but no finished file, unclaimed."""
    res = (
        client.table("persona_activities")
        .select("id,persona_id,channel_id,title,content_meta")
        .eq("kind", "video")
        # "publishing" rows carrying finished HeyGen clips are the publish
        # cron's parked leftovers; the stage == "clips_ready" + no-final_url
        # gate below keeps the worker away from anything still in flight.
        .in_("status", ["approved", "scheduled", "publishing"])
        .execute()
    )
    now = datetime.now(timezone.utc)
    cands = []
    for row in res.data or []:
        meta = row.get("content_meta") or {}
        if meta.get("stage") != "clips_ready" or meta.get("final_url"):
            continue
        if meta.get("worker_failed_at"):
            # Parked for good — unless the draft changed since it failed, in
            # which case the new script deserves its own attempts.
            blocks = meta.get("blocks")
            current = "\n\n".join(blocks) if isinstance(blocks, list) else None
            if meta.get("worker_failed_script") == current:
                continue
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
    meta["worker_claim_at"] = now.isoformat()
    client.table("persona_activities").update({"content_meta": meta}).eq("id", job["id"]).execute()
    job["content_meta"] = meta
    return job


def fail_job(client, job: dict, message: str) -> None:
    meta = dict(job.get("content_meta") or {})
    meta.pop("worker_claim_at", None)
    meta["worker_error"] = message[:500]
    attempts = int(meta.get("worker_attempts") or 0) + 1
    meta["worker_attempts"] = attempts
    if attempts >= MAX_ATTEMPTS:
        # Terminal, but re-opens on its own: the fingerprint below lets a
        # corrected draft retry while the same broken script stays parked.
        # A person clears worker_failed_at (or fixes the draft) to retry.
        meta["worker_failed_at"] = datetime.now(timezone.utc).isoformat()
        blocks = meta.get("blocks")
        meta["worker_failed_script"] = "\n\n".join(blocks) if isinstance(blocks, list) else None
    client.table("persona_activities").update({"content_meta": meta}).eq("id", job["id"]).execute()


def run_job(client, model, job: dict, bucket: str, render_script: str, work_root: Path) -> None:
    aid, pid = job["id"], job["persona_id"]
    log("job", aid)
    Path(work_root).mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="vjob-", dir=str(work_root)))
    try:
        meta = dict(job.get("content_meta") or {})
        clips: list[str] = [u for u in meta.get("video_urls", []) if isinstance(u, str) and u]
        slides: list[dict] = meta.get("slides") or []
        if len(slides) != len(clips) - 1:
            # Intro (block 1) has no slide; anything else is a malformed draft
            # the agent validator should have refused — refuse it here too.
            fail_job(client, job, f"slides_mismatch: {len(slides)} outlines for {len(clips)} clips")
            log("job refused: slides mismatch", aid)
            return

        chan = (
            client.table("persona_channels")
            .select("channel_config")
            .eq("id", job["channel_id"])
            .maybe_single()
            .execute()
        )
        cfg = ((chan.data or {}).get("channel_config")) or {}
        site = str(cfg.get("youtube_site_url") or "agentwrotethis.dev")
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

        slide_pngs = []
        for i, spec in enumerate(slides):
            p = work / f"slide{i + 2}.png"
            render_slide(spec, site, p)
            slide_pngs.append(str(p))

        def dur(p: str) -> float:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                                "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", p],
                               capture_output=True, text=True, check=True)
            return round(float(r.stdout.strip()), 2)

        plan = {
            "version": 1,
            "segments": [
                {"kind": "intro", "avatarMp4": clip_paths[0], "durationSeconds": dur(clip_paths[0])},
                *[{"kind": "slide", "slidePng": png, "avatarMp4": cp, "durationSeconds": dur(cp)}
                  for png, cp in zip(slide_pngs, clip_paths[1:])],
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
        meta["stage"] = "ready"
        meta.pop("worker_claim_at", None)
        meta.pop("worker_error", None)
        client.table("persona_activities").update({
            "content_meta": meta,
            "status": "approved",
        }).eq("id", aid).execute()
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
