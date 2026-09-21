# Video worker

One replica. Polls Supabase for approved `video` activities with avatar clips
ready (`content_meta.stage = clips_ready`) and no finished file, then builds
the mp4: on-camera blocks full frame, slide blocks with the avatar in a
corner bubble (slides from `worker/slides.py`, headless Chromium: a layout
template, or the agent's own HTML), Whisper captions, karaoke burn, music
bed. Uploads to the `persona-videos` Storage bucket, points the activity at
`final_url` and sends it back to the review queue as a draft: a person
watches it there, and approving it is what the publish cron uploads.

Previews ("Render preview" on a draft, test drafts included) go through the
same path and simply stay drafts.

## Run locally

```bash
export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
export RENDER_SCRIPT=/path/to/seo-copilot/scripts/render-video-from-plan.py
pip install -r worker/requirements.txt && python -m playwright install chromium
python3 worker/render_worker.py
```

Needs ffmpeg + DejaVu fonts on PATH for the render script. Slides alone:
`python3 worker/slides.py slides.json out/` renders one PNG per spec.

## Deploy (Railway)

New service from `worker/Dockerfile`, **exactly 1 replica** (two workers
would double paid HeyGen-adjacent work; the claim stamp is only a backstop).
Env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STORAGE_BUCKET=persona-videos`
(public bucket — create it first), `WHISPER_MODEL=small`.

Cost to know: Whisper small on CPU takes ~1-2 min per 100s of audio; the
service idles between 5-minute polls.
