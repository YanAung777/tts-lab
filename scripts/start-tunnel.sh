#!/usr/bin/env bash
# Supervised public tunnel for the TTS Lab backend.
#
#   bash scripts/start-tunnel.sh [logfile]
#
# Runs an SSH tunnel to localhost.run (no account needed) in a supervision
# loop: if the SSH session drops, it reconnects and the URL is rewritten.
#
# The public URL is written to .tunnel/url — treat that file as the single
# source of truth. The supervisor PID is in .tunnel/tunnel.pid.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-4180}"
LOG="${1:-/tmp/tunnel.log}"
mkdir -p .tunnel

# Stop a previous supervisor.
if [ -f .tunnel/tunnel.pid ] && kill -0 "$(cat .tunnel/tunnel.pid)" 2>/dev/null; then
  kill "$(cat .tunnel/tunnel.pid)" 2>/dev/null || true
  sleep 1
  pkill -P "$(cat .tunnel/tunnel.pid)" 2>/dev/null || true
fi
rm -f .tunnel/url

# The supervisor must outlive this shell, so it detaches fully.
nohup setsid bash -c '
  cd "'"$(pwd)"'"
  PORT="'"$PORT"'"
  LOG="'"$LOG"'"
  while true; do
    ssh -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o ServerAliveInterval=20 \
        -o ServerAliveCountMax=6 \
        -o ExitOnForwardFailure=yes \
        -R 80:localhost:"$PORT" \
        nokey@localhost.run >> "$LOG" 2>&1
    echo "--- tunnel disconnected, reconnecting in 3s ---" >> "$LOG"
    sleep 3
  done
' > /dev/null 2>&1 < /dev/null &

SUP_PID=$!
echo "$SUP_PID" > .tunnel/tunnel.pid

# Wait for a URL to appear.
for _ in $(seq 1 45); do
  URL=$(grep -oE "https://[a-z0-9-]+\.lhr\.life" "$LOG" 2>/dev/null | tail -1 || true)
  if [ -n "$URL" ]; then
    echo "$URL" > .tunnel/url
    echo "Tunnel up: $URL"
    echo "  url written to .tunnel/url"
    exit 0
  fi
  sleep 1
done

echo "Tunnel did not come up within 45s. Log tail:"
tail -20 "$LOG"
exit 1
