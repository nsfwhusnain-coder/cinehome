#!/usr/bin/env bash
# Deploy CineHome from the authoritative Git tree on the production server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Production is built only from clean `main` in /home/hussy/cinehome. Developer
# mirrors must push a reviewed branch and fast-forward it there; this script
# deliberately refuses rsync so the authority cannot silently diverge from Git.
# Optional overrides (never put secrets here):
#   DEPLOY_PATH=/home/hussy/cinehome
#   DEPLOY_HEALTH_URL=http://127.0.0.1:4445  (or public URL)
#   SKIP_RSYNC=1  — required acknowledgement of server-side deploy
DEPLOY_PATH="${DEPLOY_PATH:-/home/hussy/cinehome}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:4445}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
PREDEPLOY_SNAPSHOT_DIR="${PREDEPLOY_SNAPSHOT_DIR:-}"
SKIP_RSYNC="${SKIP_RSYNC:-0}"

if [[ "${DEPLOY_PATH}" != "/home/hussy/cinehome" ]]; then
  echo "ERROR: production DEPLOY_PATH must be /home/hussy/cinehome (got: ${DEPLOY_PATH})." >&2
  exit 1
fi

if [[ "${SKIP_RSYNC}" != "1" ]]; then
  echo "ERROR: production deploys must run from server Git main with SKIP_RSYNC=1." >&2
  echo "       Push a reviewed branch, fast-forward it in ${DEPLOY_PATH}, then rerun there." >&2
  exit 1
fi

echo "=== CineHome deploy ==="
echo "path=${DEPLOY_PATH} source=server-git-main"

remote_script="$(cat <<'REMOTE'
set -euo pipefail
cd "$DEPLOY_PATH"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${repo_root}" ]] || [[ "$(cd "${repo_root}" && pwd -P)" != "$(pwd -P)" ]]; then
  echo "ERROR: DEPLOY_PATH is not the root of the authoritative Git tree." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "ERROR: production deploys require the authoritative main branch." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "ERROR: authoritative main has uncommitted or untracked changes." >&2
  git status --short >&2
  exit 1
fi
current_revision="$(git rev-parse HEAD)"
if [[ -z "${EXPECTED_REVISION}" ]] || [[ "${EXPECTED_REVISION}" != "${current_revision}" ]]; then
  echo "ERROR: EXPECTED_REVISION must equal the full reviewed main SHA (${current_revision})." >&2
  exit 1
fi
export CINEHOME_REVISION="${current_revision}"
echo "source OK: main@${current_revision:0:12}"

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
if ! docker inspect cinehome >/dev/null 2>&1; then
  echo "ERROR: no live cinehome container exists to preserve before cutover." >&2
  exit 1
fi
live_image_id="$(docker inspect --format '{{.Image}}' cinehome)"
if ! docker image inspect "${live_image_id}" >/dev/null 2>&1; then
  echo "ERROR: live CineHome image metadata is unavailable: ${live_image_id}" >&2
  echo "       Reconstruct and prove a rollback image before building." >&2
  exit 1
fi

if [[ -z "${PREDEPLOY_SNAPSHOT_DIR}" ]] \
  || [[ "${PREDEPLOY_SNAPSHOT_DIR}" != /home/hussy/cinehome-backups/* ]] \
  || [[ ! -f "${PREDEPLOY_SNAPSHOT_DIR}/MANIFEST" ]] \
  || [[ ! -f "${PREDEPLOY_SNAPSHOT_DIR}/SHA256SUMS" ]]; then
  echo "ERROR: PREDEPLOY_SNAPSHOT_DIR must name a completed protected CineHome snapshot." >&2
  exit 1
fi
snapshot_mode="$(stat -c '%a' "${PREDEPLOY_SNAPSHOT_DIR}")"
if (( (8#${snapshot_mode} & 077) != 0 )); then
  echo "ERROR: predeploy snapshot permissions are too broad: ${snapshot_mode}." >&2
  exit 1
fi
if ! find "${PREDEPLOY_SNAPSHOT_DIR}/MANIFEST" -mmin -60 -print -quit | grep -q .; then
  echo "ERROR: predeploy snapshot is older than 60 minutes." >&2
  exit 1
fi
if ! (
  cd "${PREDEPLOY_SNAPSHOT_DIR}"
  sha256sum -c SHA256SUMS >/dev/null
); then
  echo "ERROR: predeploy snapshot checksum verification failed." >&2
  exit 1
fi
snapshot_image_id="$(
  awk -F= '$1 == "image_id" { print $2 }' "${PREDEPLOY_SNAPSHOT_DIR}/MANIFEST"
)"
snapshot_rollback_tag="$(
  awk -F= '$1 == "rollback_tag" { print $2 }' "${PREDEPLOY_SNAPSHOT_DIR}/MANIFEST"
)"
if [[ "${snapshot_image_id}" != "${live_image_id}" ]] \
  || [[ "$(docker image inspect --format '{{.Id}}' "${snapshot_rollback_tag}" 2>/dev/null || true)" != "${live_image_id}" ]]; then
  echo "ERROR: predeploy snapshot does not resolve to the exact live image." >&2
  exit 1
fi
echo "snapshot OK: ${PREDEPLOY_SNAPSHOT_DIR}"

live_schema_hash="$(
  docker exec cinehome sha256sum /app/prisma/schema.prisma 2>/dev/null \
    | awk '{print $1}'
)"
candidate_schema_hash="$(sha256sum prisma/schema.prisma | awk '{print $1}')"
if [[ -z "${live_schema_hash}" ]] || [[ "${live_schema_hash}" != "${candidate_schema_hash}" ]]; then
  echo "ERROR: automatic db push is forbidden across a Prisma schema change." >&2
  echo "       Ship an explicit reviewed migration/rollback procedure first." >&2
  exit 1
fi

predeploy_tag="${PREDEPLOY_TAG:-cinehome-cinehome:predeploy-$(date -u +%Y%m%dT%H%M%SZ)}"
if docker image inspect "${predeploy_tag}" >/dev/null 2>&1; then
  echo "ERROR: refusing to overwrite existing rollback tag: ${predeploy_tag}" >&2
  exit 1
fi
docker image tag "${live_image_id}" "${predeploy_tag}"
echo "rollback image tagged: ${predeploy_tag} -> ${live_image_id}"

HEALTH_TIMEOUT_SECONDS=180
HEALTH_REQUEST_MAX_SECONDS=2
source scripts/deploy-runtime.sh

docker compose build
arm_cutover_rollback
if ! docker compose up -d; then
  echo "ERROR: Compose failed to start the candidate; armed rollback will run." >&2
  exit 1
fi

# Fail closed unless Compose's dual app+scraper health check is healthy, the
# configured app URL responds, and the internal scraper endpoint responds.
if ! wait_for_runtime_health "${HEALTH_TIMEOUT_SECONDS}"; then
  echo "ERROR: deployment did not reach healthy app+scraper state within ${HEALTH_TIMEOUT_SECONDS} seconds." >&2
  echo "       container_health=${container_health:-missing} app_ok=${app_ok:-0} scraper_ok=${scraper_ok:-0}" >&2
  echo "       restart_count=${restart_count:-unknown} oom_killed=${oom_killed:-unknown}" >&2
  docker compose ps || true
  docker compose logs --tail=100 cinehome || true
  exit 1
fi

deployed_revision="$(
  docker image inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$(docker inspect --format '{{.Image}}' cinehome)"
)"
if [[ "${deployed_revision}" != "${current_revision}" ]]; then
  echo "ERROR: healthy runtime image revision ${deployed_revision:-missing} does not match ${current_revision}." >&2
  exit 1
fi
disarm_cutover_rollback
echo "health OK (Compose app+scraper, HTTP, zero restarts/OOM)"
echo "revision OK: ${deployed_revision}"
REMOTE
)"

# Shell-escape env values so paths/URLs with quotes or spaces cannot break remote eval.
printf -v remote_env \
  'export DEPLOY_PATH=%q; export DEPLOY_HEALTH_URL=%q; export EXPECTED_REVISION=%q; export PREDEPLOY_SNAPSHOT_DIR=%q\n' \
  "${DEPLOY_PATH}" "${DEPLOY_HEALTH_URL}" "${EXPECTED_REVISION}" "${PREDEPLOY_SNAPSHOT_DIR}"

eval "${remote_env}"
bash -c "${remote_script}"

echo "=== deploy finished ==="
