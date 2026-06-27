#!/usr/bin/env bash
set -euo pipefail

# Optional overrides:
#   API_UPSTREAM=http://localhost:8080 PORT=3000 ./start.sh

API_UPSTREAM="${API_UPSTREAM:-http://localhost:8080}" \
PORT="${PORT:-3000}" \
python3 "$(dirname "$0")/server.py"
