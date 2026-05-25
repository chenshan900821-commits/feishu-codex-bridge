#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f bridge.pid ]; then
  PID="$(cat bridge.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Stopped bridge PID=$PID"
  else
    echo "No running process for PID=$PID"
  fi
  rm -f bridge.pid
  exit 0
fi

echo "No bridge.pid found."
