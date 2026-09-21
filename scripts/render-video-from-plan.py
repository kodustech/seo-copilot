#!/usr/bin/env python3
"""Render a finished presenter video from a composite plan (see
lib/influencer/video-composite.ts).

Usage:
    python3 scripts/render-video-from-plan.py plan.json

Needs: ffmpeg + ffprobe on PATH, DejaVu Sans Bold (or pass --font).
Pipeline, proven on the agentwrotethis POC: face segments full frame, slide
segments with the avatar in a circular bubble, in any order -> concat ->
burned captions (karaoke when wordsJson is present) -> music bed mix.

Writes <outputMp4> next to a <output>-captioned.mp4 when captions exist.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CIRCLE_R = 166
CIRCLE_C = 170
BUBBLE_SIZE = 340
BUBBLE_X = "W-380"
BUBBLE_Y = "H-380"


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed: {r.stderr[-800:]}")


def probe_duration(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def esc_text(s: str) -> str:
    # ffmpeg text expansion chokes on stray % (and brackets confuse filter
    # parsing), so neutralize everything structural. Agent-written words like
    # "30%" must never abort a render minutes into ffmpeg work.
    return (
        s.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(":", "\\:")
        .replace("'", "")
        .replace(",", "\\,")
    )


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    ap.add_argument("--workdir", default=None)
    args = ap.parse_args()

    plan = json.loads(Path(args.plan).read_text())
    assert plan.get("version") == 1, "unsupported plan version"
    work = Path(args.workdir or tempfile.mkdtemp(prefix="videorender-"))
    work.mkdir(parents=True, exist_ok=True)

    seg_files: list[str] = []
    circle = (
        f"crop=640:640:(in_w-640)/2:60,scale={BUBBLE_SIZE}:{BUBBLE_SIZE},"
        f"format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
        f"a='if(lte(sqrt(pow(X-{CIRCLE_C},2)+pow(Y-{CIRCLE_C},2)),{CIRCLE_R}),255,0)'"
    )
    for i, seg in enumerate(plan["segments"]):
        out = str(work / f"seg{i}.mp4")
        # "intro" is the older name for an on-camera segment.
        if seg["kind"] in ("face", "intro"):
            run(["ffmpeg", "-y", "-v", "error", "-i", seg["avatarMp4"],
                 "-filter_complex", "[0:v]scale=1920:1080,fps=30[v]",
                 "-map", "[v]", "-map", "0:a",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out])
        elif seg["kind"] == "slide":
            dur = probe_duration(seg["avatarMp4"])
            fc = (f"[1:v]{circle}[b];"
                  "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,"
                  f"crop=1920:1080,setsar=1,fps=30[bg];[bg][b]overlay={BUBBLE_X}:{BUBBLE_Y}:format=yuv420[v]")
            run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", seg["slidePng"],
                 "-i", seg["avatarMp4"], "-filter_complex", fc,
                 "-map", "[v]", "-map", "1:a",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                 "-shortest", "-t", str(dur), out])
        else:
            raise ValueError(f"unknown segment kind: {seg.get('kind')}")
        seg_files.append(out)
        print(f"seg{i} ok", flush=True)

    concat = work / "concat.txt"
    concat.write_text("".join(f"file '{f}'\n" for f in seg_files))
    final = plan["outputMp4"]
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-c", "copy", final])
    print(f"assembled {final}", flush=True)

    if plan.get("captionsSrt"):
        cap = str(Path(final).with_name(Path(final).stem + "-captioned.mp4"))
        if plan.get("wordsJson"):
            words = json.loads(Path(plan["wordsJson"]).read_text())
            fc_file = work / "karaoke.txt"
            fc_file.write_text("[0:v]fps=30," + build_karaoke(words, args.font) + "[v]")
            run(["ffmpeg", "-y", "-v", "error", "-i", final,
                 "-filter_complex_script", str(fc_file),
                 "-map", "[v]", "-map", "0:a",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", cap])
        else:
            run(["ffmpeg", "-y", "-v", "error", "-i", final,
                 "-vf", f"subtitles={plan['captionsSrt']}",
                 "-c:a", "copy", cap])
        print(f"captioned {cap}", flush=True)
        final = cap

    if plan.get("musicMp3"):
        mixed = str(Path(final).with_name(Path(final).stem + "-music.mp4"))
        total = probe_duration(final)
        level = plan.get("musicLevel", 0.08)
        run(["ffmpeg", "-y", "-v", "error", "-i", final, "-i", plan["musicMp3"],
             "-filter_complex",
             f"[1:a]volume={level},afade=t=in:st=0:d=2,"
             f"afade=t=out:st={max(total - 5, 0):.0f}:d=5,apad=whole_dur={total:.0f}[m];"
             "[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]",
             "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
             "-shortest", mixed])
        print(f"mixed {mixed}", flush=True)


def build_karaoke(words: list[dict], font: str) -> str:
    """TikTok word-highlight chain. Words: [{w, s, e}]. Uppercase, 4-word
    lines, active word green. Measures with DejaVu Bold to match ffmpeg."""
    from PIL import ImageFont
    face = ImageFont.truetype(font, 64)
    space = face.getlength(" ")
    lines: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        t = (w.get("w") or "").strip().upper()
        if not t:
            continue
        cur.append({"t": t, "s": float(w["s"]), "e": float(w["e"])})
        chars = sum(len(x["t"]) for x in cur) + len(cur)
        if len(cur) >= 4 or chars >= 26 or t[-1] in ".?!":
            lines.append(cur)
            cur = []
    if cur:
        lines.append(cur)
    filters: list[str] = []
    y = 800
    for line in lines:
        widths = [face.getlength(x["t"]) for x in line]
        total = sum(widths) + space * (len(line) - 1)
        full = " ".join(x["t"] for x in line)
        t1, t2 = line[0]["s"], line[-1]["e"]
        filters.append(
            f"drawtext=text='{esc_text(full)}':fontfile={font}:fontsize=64:"
            f"fontcolor=white:borderw=3:bordercolor=black:"
            f"x=(w-text_w)/2:y={y}:enable='between(t\\,{t1:.2f}\\,{t2:.2f})'")
        off = 0.0
        for xw, ww in zip(widths, line):
            filters.append(
                f"drawtext=text='{esc_text(ww['t'])}':fontfile={font}:fontsize=64:"
                f"fontcolor=#34D399:borderw=3:bordercolor=black:"
                f"x=(w-{total:.0f})/2+{off:.0f}:y={y}:"
                f"enable='between(t\\,{ww['s']:.2f}\\,{ww['e']:.2f})'")
            off += xw + space
    return ",".join(filters)


if __name__ == "__main__":
    main()
