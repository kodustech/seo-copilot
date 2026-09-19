# Video worker

One replica. Polls Supabase for approved `video` activities with avatar clips
ready (`content_meta.stage = clips_ready`) and no finished file, then builds
the mp4: slides from the queued outlines, Whisper captions, karaoke burn,
music bed. Uploads to the `persona-videos` Storage bucket and points the
activity at `final_url` — the publish cron uploads it to YouTube (unlisted)
from there.

## Run locally

```bash
export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
export RENDER_SCRIPT=/path/to/seo-copilot/scripts/render-video-from-plan.py
python3 worker/render_worker.py
```

Needs ffmpeg + DejaVu fonts on PATH for the render script.

## Deploy (Railway)

New service from `worker/Dockerfile`, **exactly 1 replica** (two workers
would double paid HeyGen-adjacent work; the claim stamp is only a backstop).
Env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STORAGE_BUCKET=persona-videos`
(public bucket — create it first), `WHISPER_MODEL=small`.

Cost to know: Whisper small on CPU takes ~1-2 min per 100s of audio; the
service idles between 5-minute polls.
