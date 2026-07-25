#!/usr/bin/env bash
# Abort deploy/build if free disk on / is under 20GB.
set -euo pipefail

MIN_FREE_GB=20
MIN_FREE_KB=$((MIN_FREE_GB * 1024 * 1024))

echo "=== disk preflight (require >= ${MIN_FREE_GB}GB free on /) ==="
df -h /
# -P: POSIX portable one-line-per-filesystem output (avoids wrapped device names)
df -kP /

# Available blocks in 1K units (POSIX df -kP: fixed columns, no wrap)
avail_kb="$(df -kP / | awk 'NR==2 {print $4}')"
if ! [[ "${avail_kb}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse free space from df -kP /" >&2
  exit 2
fi

if (( avail_kb < MIN_FREE_KB )); then
  avail_gb="$(awk -v k="${avail_kb}" 'BEGIN { printf "%.2f", k/1024/1024 }')"
  echo "ERROR: only ${avail_gb}GB free on / (need >= ${MIN_FREE_GB}GB). Aborting." >&2
  echo "Hint: run ./scripts/disk-prune.sh then re-check." >&2
  exit 1
fi

avail_gb="$(awk -v k="${avail_kb}" 'BEGIN { printf "%.2f", k/1024/1024 }')"
echo "OK: ${avail_gb}GB free on /"

if command -v docker >/dev/null 2>&1; then
  echo
  echo "=== docker system df ==="
  docker system df || true
else
  echo "docker not found; skipping docker system df"
fi
