#!/usr/bin/env bash
# Start the TTS Lab backend server, supervised so it survives the shell.
#
#   bash scripts/start-backend.sh [port]
#
# Writes the PID to .tunnel/backend.pid and the log to .tunnel/backend.log.
# Restarts the server if it exits.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-${PORT:-4180}}"
mkdir -p .tunnel

# Stop a previous instance.
if [ -f .tunnel/backend.pid ] && kill -0 "$(cat .tunnel/backend.pid)" 2>/dev/null; then
  kill "$(cat .tunnel/backend.pid)" 2>/dev/null || true
  sleep 1
  pkill -P "$(cat .tunnel/backend.pid)" 2>/dev/null || true
fi
pkill -f "node src/server.js" 2>/dev/null || true
sleep 1

nohup setsid bash -c '
  cd "'"$(pwd)"'"
  PORT="'"$PORT"'"
  while true; do
    PORT="$PORT" TTS_ENGINE="${TTS_ENGINE:-matrix}" node src/server.js
    echo "--- backend exited, restarting in 2s ---" >> .tunnel/backend.log
    sleep 2
  done
' >> .tunnel/backend.log 2>&1 < /dev/null &

SUP_PID=$!
echo "$SUP_PID" > .tunnel/backend.pid

for _ in $(seq 1 25); do
  if curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
    echo "Backend up on http://127.0.0.1:$PORT (supervisor pid $SUP_PID)"
    curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health"
    echo
    exit 0
  fi
  sleep 1
done

echo "Backend failed to start. Log tail:"
tail -20 .tunnel/backend.log
exit 1
