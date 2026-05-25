#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

nohup node src/index.js > bridge.out.log 2> bridge.err.log &
echo "$!" > bridge.pid
echo "Bridge started. PID=$(cat bridge.pid)"
echo "Logs: $ROOT/bridge.out.log"
