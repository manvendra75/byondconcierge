# Byond Borders Cruise Concierge — production image (Railway).
# Explicit base so `python`/`pip` are guaranteed present. Runtime is Python-only;
# the Node data pipeline is build-time on a dev machine, not needed here.
FROM python:3.12-slim

# build-essential covers the few deps that may build from source (e.g. chroma's
# hnswlib); removed from the layer to keep the image lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer caches unless requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the app (committed source snapshots in data/ come along; .env, app.db and
# the vector store are git-ignored, so they are never baked from a dev machine).
COPY . .

# Bake the Chroma knowledge store INTO the image at build time. It is read-only
# reference data rebuilt from committed sources, so it belongs in the image — this
# keeps BOOT fast (no per-start re-embedding, which was overrunning the healthcheck).
# Uses the local embedding model (no API key needed at build); the model is cached
# into the image, so there is no runtime download.
#   IMPORTANT — at runtime keep these UNSET so queries match what was baked:
#     * CHROMA_DIR         -> defaults to this baked /app/data/chroma
#     * EMBEDDINGS_PROVIDER -> defaults to the same local model the store was built with
RUN python -m engine.ingest.load_knowledge

# Preempt Streamlit's first-run interactive "enter your email" prompt. In a
# non-interactive container it blocks on stdin, so the server never binds the port
# and the healthcheck fails with "service unavailable". A stub credentials file +
# headless + telemetry-off guarantees a clean, silent boot.
ENV STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    PYTHONUNBUFFERED=1
RUN mkdir -p /root/.streamlit \
    && printf '[general]\nemail = ""\n' > /root/.streamlit/credentials.toml

# Railway routes to this port and uses EXPOSE to auto-detect it.
EXPOSE 8080

# Boot: load the sailings TABLE into the (persistent) app.db on the /data volume —
# fast, no embeddings, and it only clears the sailings table so users/leads persist —
# then launch Streamlit. Boot stays quick, so the healthcheck passes in seconds.
# (railway.json's startCommand mirrors this and takes precedence.)
CMD python -m engine.ingest.load_sailings ; python -m streamlit run app.py --server.port 8080 --server.address 0.0.0.0 --server.headless true --server.enableCORS false --server.enableXsrfProtection false
