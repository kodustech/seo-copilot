# Video worker: ffmpeg + whisper + headless Chromium (slides) + supabase. CPU only.
# Pinned to bookworm: Playwright's --with-deps installs Chromium's system
# libraries by Debian release, and bookworm is the one it supports.
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

# Slide fonts. Optional on purpose: the templates fall back to DejaVu, so a
# missing package must not break the image.
RUN apt-get update \
  && (apt-get install -y --no-install-recommends fonts-inter fonts-jetbrains-mono \
      || echo "slide fonts unavailable; slides fall back to DejaVu") \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Chromium for worker/slides.py (layout templates and agent-written HTML).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python -m playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# The worker, its slide renderer, and the composite renderer it shells out to.
COPY worker/render_worker.py ./render_worker.py
COPY worker/slides.py ./slides.py
COPY scripts/render-video-from-plan.py ./scripts/render-video-from-plan.py

ENV PYTHONUNBUFFERED=1 \
    STORAGE_BUCKET=persona-videos \
    POLL_SECONDS=300 \
    WHISPER_MODEL=small \
    RENDER_SCRIPT=/app/scripts/render-video-from-plan.py \
    WORK_DIR=/tmp/video-worker

CMD ["python", "render_worker.py"]
