# Video worker: ffmpeg + whisper + supabase. CPU only.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# The composite renderer the worker shells out to.
COPY scripts/render-video-from-plan.py ./scripts/render-video-from-plan.py

ENV PYTHONUNBUFFERED=1 \
    STORAGE_BUCKET=persona-videos \
    POLL_SECONDS=300 \
    WHISPER_MODEL=small \
    RENDER_SCRIPT=/app/scripts/render-video-from-plan.py \
    WORK_DIR=/tmp/video-worker

CMD ["python", "render_worker.py"]
