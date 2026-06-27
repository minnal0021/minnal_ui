#!/usr/bin/env bash
set -euo pipefail

# ── Config (override via env vars) ────────────────────────────────────────────
IMAGE_NAME="${IMAGE_NAME:-minnal-ui}"
CONTAINER_NAME="${CONTAINER_NAME:-minnal-ui}"
PORT="${PORT:-3000}"

# With --network=host the container shares the host's network stack, so
# localhost:8080 inside the container reaches whatever is on the host's
# port 8080 (including another Docker container that has published that port).
API_UPSTREAM="${API_UPSTREAM:-http://localhost:8080}"

# ── Resolve script directory so the script works from anywhere ────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "──────────────────────────────────────────────"
echo "  Minnal UI — build & run"
echo "──────────────────────────────────────────────"
echo "  Image      : $IMAGE_NAME"
echo "  Container  : $CONTAINER_NAME"
echo "  Port       : $PORT"
echo "  API backend: $API_UPSTREAM"
echo "──────────────────────────────────────────────"

# ── Stop and remove any existing container with the same name ─────────────────
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
echo "Building Docker image '$IMAGE_NAME'..."
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

# ── Run ───────────────────────────────────────────────────────────────────────
# --network=host  shares the host's network stack so the container can reach
#                 any service on localhost (including other Docker containers
#                 that publish their ports to the host).
# Note: -p is not needed with --network=host; the server binds directly to
#       the host's port $PORT.
echo "Starting container '$CONTAINER_NAME'..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --network host \
  -e "API_UPSTREAM=${API_UPSTREAM}" \
  -e "PORT=${PORT}" \
  "$IMAGE_NAME"

# ── Print access URLs ─────────────────────────────────────────────────────────
echo ""
echo "✓ Container started"
echo ""
echo "  Local   → http://localhost:${PORT}"

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}') || true
if [[ -n "$HOST_IP" ]]; then
  echo "  Network → http://${HOST_IP}:${PORT}"
fi

echo ""
echo "  Logs : docker logs -f $CONTAINER_NAME"
echo "  Stop : docker rm -f $CONTAINER_NAME"
echo ""
