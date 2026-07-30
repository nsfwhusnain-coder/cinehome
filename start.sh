#!/bin/bash
set -euo pipefail

mkdir -p /app/db /app/transcode-cache

bunx prisma db push --skip-generate

SCRAPER_PID=""
APP_PID=""
TRANSCODER_PID=""
SCRAPER_RESTART_COUNT=0
SCRAPER_RESTART_WINDOW_START=0
MAX_RESTARTS_PER_MINUTE=3

start_scraper() {
  cd /app/mini-services/stream-scraper
  bun run start &
  SCRAPER_PID=$!
  cd /app
  echo "[start.sh] stream-scraper started (pid=$SCRAPER_PID)"
}

# Legacy whole-file transcode worker. Disabled by default: a cold HEVC/MKV
# request can consume unbounded CPU/RAM. Explicit opt-in only while retained
# for isolated development; it never blocks app boot.
start_transcoder() {
  # The worker serves TWO modes with very different resource profiles, so it
  # starts if EITHER is enabled and the app-side routes decide which mode a
  # request may use:
  #
  #   transcode (TRANSCODER_ENABLED) - decodes and re-encodes. Production
  #     default OFF: a cold 4K HEVC job measured 17.4 GiB and 1378% CPU.
  #   remux     (REMUX_ENABLED)      - stream copy, container rewrite only.
  #     Default ON: measured 60s of 4K AV1 rewrapped in 6s wall (~10x realtime),
  #     I/O bound rather than CPU bound. This is what makes MKV releases
  #     playable at all, since MKV plays in no browser.
  if [ "${TRANSCODER_ENABLED:-0}" != "1" ] && [ "${REMUX_ENABLED:-1}" != "1" ]; then
    echo "[start.sh] media worker disabled (TRANSCODER_ENABLED=1 and/or REMUX_ENABLED=1 to opt in)"
    return 0
  fi
  echo "[start.sh] media worker: transcode=${TRANSCODER_ENABLED:-0} remux=${REMUX_ENABLED:-1}"
  if [ -f /app/mini-services/transcoder/index.ts ]; then
    cd /app/mini-services/transcoder
    bun run index.ts &
    TRANSCODER_PID=$!
    cd /app
    echo "[start.sh] transcoder started (pid=$TRANSCODER_PID, port 3040)"
  else
    echo "[start.sh] transcoder module absent — skipping"
  fi
}

wait_for_scraper_health() {
  local max_wait=30
  local elapsed=0
  while [ "$elapsed" -lt "$max_wait" ]; do
    if curl -sf "http://127.0.0.1:3030/health" >/dev/null 2>&1; then
      echo "[start.sh] stream-scraper health OK"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[start.sh] stream-scraper health check timed out after ${max_wait}s"
  return 1
}

maybe_restart_scraper() {
  local now
  now=$(date +%s)
  if [ "$SCRAPER_RESTART_WINDOW_START" -eq 0 ] || [ $((now - SCRAPER_RESTART_WINDOW_START)) -ge 60 ]; then
    SCRAPER_RESTART_WINDOW_START=$now
    SCRAPER_RESTART_COUNT=0
  fi
  SCRAPER_RESTART_COUNT=$((SCRAPER_RESTART_COUNT + 1))
  if [ "$SCRAPER_RESTART_COUNT" -gt "$MAX_RESTARTS_PER_MINUTE" ]; then
    echo "[start.sh] stream-scraper exceeded max restarts ($MAX_RESTARTS_PER_MINUTE/min); exiting"
    exit 1
  fi
  echo "[start.sh] restarting stream-scraper (attempt $SCRAPER_RESTART_COUNT/$MAX_RESTARTS_PER_MINUTE in window)"
  start_scraper
  wait_for_scraper_health || exit 1
}

shutdown() {
  echo "[start.sh] shutting down..."
  if [ -n "$SCRAPER_PID" ]; then
    kill "$SCRAPER_PID" 2>/dev/null || true
  fi
  if [ -n "$TRANSCODER_PID" ]; then
    kill "$TRANSCODER_PID" 2>/dev/null || true
  fi
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
  wait "$SCRAPER_PID" "$TRANSCODER_PID" "$APP_PID" 2>/dev/null || true
  exit 0
}

trap shutdown TERM INT

start_scraper
wait_for_scraper_health || exit 1

start_transcoder

# Next's standalone output targets Node. Keep Bun for the scraper and build
# tooling, but do not put media proxy WebStreams through Bun's server bridge.
# Process substitution preserves container logs plus server.log while APP_PID
# remains the actual Node process for health supervision and clean shutdown.
NODE_ENV=production node .next/standalone/server.js > >(tee server.log) 2>&1 &
APP_PID=$!
echo "[start.sh] Next.js started (pid=$APP_PID)"

while true; do
  if ! kill -0 "$SCRAPER_PID" 2>/dev/null; then
    echo "[start.sh] stream-scraper exited unexpectedly"
    wait "$SCRAPER_PID" 2>/dev/null || true
    maybe_restart_scraper
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "[start.sh] Next.js exited unexpectedly"
    wait "$APP_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
