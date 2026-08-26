#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f "apps/node-server/static-dist/app.js" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    echo "Building frontend assets..."
    if ! pnpm run build; then
      echo "Frontend build failed; attempting pnpm install and retrying..." >&2
      pnpm install
      pnpm run build
    fi
  else
    echo "Frontend bundle missing and pnpm is not available." >&2
    exit 1
  fi
fi

exec npm run server:dev
