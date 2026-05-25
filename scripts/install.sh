#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill FEISHU_APP_ID, FEISHU_APP_SECRET, CODEX_ROOT, then run npm run doctor."
else
  echo ".env already exists; leaving it unchanged."
fi

npm run check
