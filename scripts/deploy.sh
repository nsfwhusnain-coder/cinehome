#!/usr/bin/env bash
# Deploy CineHome to the server (or build/up locally).
# Does NOT hardcode passwords. Uses SSH agent / your own keys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Optional overrides (never put secrets here):
#   DEPLOY_HOST=hussy@100.89.184.84
#   DEPLOY_SSH_PORT=58222
#   DEPLOY_PATH=/home/hussy/cinehome
#   DEPLOY_HEALTH_URL=http://127.0.0.1:4445  (or public URL)
#   SKIP_RSYNC=1  — only run compose on current host (server-side)
#   DEPLOY_I_MEAN_IT=1 — allow non-/cinehome DEPLOY_PATH (dangerous with rsync --delete)
DEPLOY_HOST="${DEPLOY_HOST:-hussy@100.89.184.84}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-58222}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/hussy/cinehome}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:4445}"
SKIP_RSYNC="${SKIP_RSYNC:-0}"
DEPLOY_I_MEAN_IT="${DEPLOY_I_MEAN_IT:-0}"

# Guard rsync --delete target: refuse paths that do not end with /cinehome
# unless the operator explicitly opts in.
if [[ "${DEPLOY_PATH}" != */cinehome ]] && [[ "${DEPLOY_I_MEAN_IT}" != "1" ]]; then
  echo "ERROR: DEPLOY_PATH must end with '/cinehome' (got: ${DEPLOY_PATH})." >&2
  echo "       Override with DEPLOY_I_MEAN_IT=1 only if you intend rsync --delete there." >&2
  exit 1
fi

ssh_base() {
  ssh -p "${DEPLOY_SSH_PORT}" "${DEPLOY_HOST}" "$@"
}

echo "=== CineHome deploy ==="
echo "host=${DEPLOY_HOST} port=${DEPLOY_SSH_PORT} path=${DEPLOY_PATH}"

if [[ "${SKIP_RSYNC}" != "1" ]]; then
  echo
  echo "=== rsync tree (excludes secrets, node_modules, .next, db) ==="
  # Preserve server .env and db/; never push local secrets by default.
  # Include .env.example before the catch-all .env.* exclude (rsync first-match).
  rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'mini-services/stream-scraper/node_modules/' \
    --exclude '.next/' \
    --exclude 'db/' \
    --exclude '.env' \
    --include '.env.example' \
    --exclude '.env.*' \
    --exclude '*.log' \
    -e "ssh -p ${DEPLOY_SSH_PORT}" \
    "${ROOT}/" "${DEPLOY_HOST}:${DEPLOY_PATH}/"
else
  echo "SKIP_RSYNC=1 — assuming code is already at ${DEPLOY_PATH} on this host"
fi

remote_script="$(cat <<'REMOTE'
set -euo pipefail
cd "$DEPLOY_PATH"
chmod +x scripts/*.sh start.sh 2>/dev/null || true
./scripts/disk-preflight.sh

# Docker RUN steps normally use the daemon/host resolver, which can be broken
# while CineHome's explicit container DNS remains healthy. Resolve nodejs.org
# through the running production container when possible and pass the address
# only to curl's TLS-verified --resolve path in the Dockerfile.
if [[ -z "${NODE_DOWNLOAD_IP:-}" ]] && docker inspect cinehome >/dev/null 2>&1; then
  NODE_DOWNLOAD_IP="$(
    docker exec cinehome getent ahostsv4 nodejs.org 2>/dev/null \
      | awk 'NR == 1 { print $1 }'
  )"
fi
if [[ -n "${NODE_DOWNLOAD_IP:-}" ]]; then
  export NODE_DOWNLOAD_IP
  echo "Node runtime download address resolved"
fi

# Compose retags `cinehome-cinehome:latest` during a build. BuildKit may then
# discard metadata for the image still backing the live container, which makes
# that otherwise-healthy image impossible to tag after the build. Capture the
# exact live image before touching `latest`; fail closed if Docker can no longer
# resolve it, because continuing would mean deploying without an image rollback.
if docker inspect cinehome >/dev/null 2>&1; then
  live_image_id="$(docker inspect --format '{{.Image}}' cinehome)"
  if ! docker image inspect "${live_image_id}" >/dev/null 2>&1; then
    echo "ERROR: live CineHome image metadata is unavailable: ${live_image_id}" >&2
    echo "       Reconstruct and prove a rollback image before building." >&2
    exit 1
  fi
  predeploy_tag="${PREDEPLOY_TAG:-cinehome-cinehome:predeploy-$(date -u +%Y%m%dT%H%M%SZ)}"
  if docker image inspect "${predeploy_tag}" >/dev/null 2>&1; then
    echo "ERROR: refusing to overwrite existing rollback tag: ${predeploy_tag}" >&2
    exit 1
  fi
  docker image tag "${live_image_id}" "${predeploy_tag}"
  echo "rollback image tagged: ${predeploy_tag} -> ${live_image_id}"
fi

docker compose build
docker compose up -d
# Health: published app port (compose maps 4445:3000). Scraper stays internal :3030.
for i in $(seq 1 30); do
  if curl -sf --max-time 5 "$DEPLOY_HEALTH_URL" >/dev/null 2>&1 \
    || curl -sf --max-time 5 "http://127.0.0.1:4445" >/dev/null 2>&1; then
    echo "health OK (HTTP)"
    exit 0
  fi
  if docker exec cinehome curl -sf --max-time 5 http://127.0.0.1:3030/health >/dev/null 2>&1; then
    echo "health OK (scraper inside container); waiting for app..."
  fi
  sleep 2
done
echo "WARNING: health curl did not succeed within timeout; check: docker compose logs --tail=100" >&2
docker compose ps || true
exit 1
REMOTE
)"

# Shell-escape env values so paths/URLs with quotes or spaces cannot break remote eval.
printf -v remote_env 'export DEPLOY_PATH=%q; export DEPLOY_HEALTH_URL=%q\n' \
  "${DEPLOY_PATH}" "${DEPLOY_HEALTH_URL}"

if [[ "${SKIP_RSYNC}" == "1" ]]; then
  eval "${remote_env}"
  bash -c "${remote_script}"
else
  ssh_base "bash -s" <<EOF
${remote_env}
${remote_script}
EOF
fi

echo "=== deploy finished ==="
