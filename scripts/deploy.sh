#!/usr/bin/env bash
# Deploy Airwave via docker compose (Docker hosts).
# - Creates .env with a random WATCHTOWER_TOKEN on first run (never overwrites)
# - Starts airwave + watchtower, waits for health, prints status
# For bare-metal local runs use scripts/run_dev.sh instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
TOKEN_VAR="WATCHTOWER_TOKEN"

fail() { echo "ERROR: $*" >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Docker is not installed. Install it with:

  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  newgrp docker   # or log out and back in

Then re-run: ./scripts/deploy.sh
EOF
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose plugin is not available"
fi

if ! docker info >/dev/null 2>&1; then
  fail "cannot reach the Docker daemon (are you in the 'docker' group? try: newgrp docker)"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(openssl rand -hex 16)"
  echo "${TOKEN_VAR}=${TOKEN}" > "$ENV_FILE"
  echo "Created ${ENV_FILE} with a generated ${TOKEN_VAR}."
else
  if ! grep -q "^${TOKEN_VAR}=" "$ENV_FILE"; then
    TOKEN="$(openssl rand -hex 16)"
    echo "${TOKEN_VAR}=${TOKEN}" >> "$ENV_FILE"
    echo "Added a generated ${TOKEN_VAR} to existing ${ENV_FILE}."
  fi
fi

echo "Pulling latest images..."
docker compose pull

echo "Starting containers..."
docker compose up -d

echo "Waiting for the app to answer on :8000..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
  echo "ERROR: app did not become healthy within 60s" >&2
  docker compose ps
  docker compose logs --tail 40 airwave >&2 || true
  exit 1
fi

VERSION="$(curl -fsS http://127.0.0.1:8000/api/system/version 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
UPGRADE="$(curl -fsS http://127.0.0.1:8000/api/system/updates 2>/dev/null | sed -n 's/.*"can_upgrade":\([a-z]*\).*/\1/p')"

cat <<EOF

Deployed.
  UI:        http://$(hostname -I 2>/dev/null | awk '{print $1}'):8000
  Health:    http://127.0.0.1:8000/api/health
  Version:   ${VERSION:-unknown}
  In-app update button: $([[ "${UPGRADE}" == "true" ]] && echo "enabled (Watchtower reachable)" || echo "DISABLED (check watchtower container)")
EOF
