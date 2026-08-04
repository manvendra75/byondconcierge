# Byond Borders Cruise Concierge — production image (Railway).
# Explicit base so `python`/`pip` are guaranteed present (the auto-builder wasn't
# providing a Python runtime). Runtime is Python-only; the Node data pipeline is
# build-time on a dev machine, not needed here.
FROM python:3.12-slim

# build-essential covers the few deps that may build from source (e.g. chroma's
# hnswlib) when no wheel matches; removed from the layer to keep the image lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer caches unless requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the app (committed source snapshots in data/ come along; .env, app.db and
# the vector store are git-ignored, so they are never baked into the image).
COPY . .

# Railway injects $PORT. On boot: (re)build the SQLite sailings table + Chroma
# store on the mounted /data volume (idempotent), then launch Streamlit. Shell
# form so $PORT expands and && chains. (railway.json's startCommand, if set,
# overrides this — keep the two in step.)
CMD python -m engine.ingest.load \
    && python -m streamlit run app.py --server.port ${PORT:-8501} --server.address 0.0.0.0 --server.headless true
