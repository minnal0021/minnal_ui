# ── Minnal UI ──────────────────────────────────────────────────────────────────
# Serves static files and proxies /stores + /admin to the backend API.
# Pure Python stdlib — no pip installs, no extra dependencies.
#
# Build:
#   docker build -t minnal-ui .
#
# Run (API on same Docker network, service named "minnal_api"):
#   docker run -p 3000:3000 minnal-ui
#
# Run (custom API host):
#   docker run -p 3000:3000 -e API_UPSTREAM=http://my-api-host:8080 minnal-ui
# ──────────────────────────────────────────────────────────────────────────────
FROM python:3.12-alpine

WORKDIR /app

# Copy static UI assets
COPY index.html .
COPY css/       css/
COPY js/        js/
COPY img/       img/

# Copy the server
COPY server.py  .

ENV API_UPSTREAM=http://minnal_api:8080
ENV PORT=3000

EXPOSE 3000

CMD ["python", "server.py"]
