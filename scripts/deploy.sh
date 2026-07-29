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
echo "source OK: main@$(git rev-parse --short=12 HEAD)"

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
predeploy_tag=""
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

HEALTH_TIMEOUT_SECONDS=180
HEALTH_REQUEST_MAX_SECONDS=2

wait_for_runtime_health() {
  local timeout_seconds="$1"
  local health_deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < health_deadline )); do
    container_health="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        cinehome 2>/dev/null || true
    )"
    restart_count="$(docker inspect --format '{{.RestartCount}}' cinehome 2>/dev/null || true)"
    oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' cinehome 2>/dev/null || true)"

    app_ok=0
    scraper_ok=0
    if curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}" "$DEPLOY_HEALTH_URL" >/dev/null 2>&1; then
      app_ok=1
    fi
    if docker exec cinehome curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}" \
      http://127.0.0.1:3030/health >/dev/null 2>&1; then
      scraper_ok=1
    fi

    if [[ "${container_health}" == "healthy" ]] \
      && [[ "${app_ok}" == "1" ]] \
      && [[ "${scraper_ok}" == "1" ]] \
      && [[ "${restart_count}" == "0" ]] \
      && [[ "${oom_killed}" == "false" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_live_image() {
  if [[ -z "${predeploy_tag}" ]]; then
    echo "ERROR: no predeploy image tag is available for automatic rollback." >&2
    return 1
  fi
  echo "ROLLBACK: restoring ${predeploy_tag}" >&2
  docker image tag "${predeploy_tag}" cinehome-cinehome:latest
  docker compose up -d --no-deps --force-recreate cinehome
  if ! wait_for_runtime_health 120; then
    echo "ERROR: automatic image rollback did not return to a healthy runtime." >&2
    docker compose ps || true
    docker compose logs --tail=100 cinehome || true
    return 1
  fi
  echo "ROLLBACK OK: ${predeploy_tag} is healthy again" >&2
}

docker compose build
if ! docker compose up -d; then
  echo "ERROR: Compose failed to start the candidate; rolling back." >&2
  rollback_live_image || true
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
  rollback_live_image || true
  exit 1
fi

echo "health OK (Compose app+scraper, HTTP, zero restarts/OOM)"
REMOTE
)"

# Shell-escape env values so paths/URLs with quotes or spaces cannot break remote eval.
printf -v remote_env 'export DEPLOY_PATH=%q; export DEPLOY_HEALTH_URL=%q\n' \
  "${DEPLOY_PATH}" "${DEPLOY_HEALTH_URL}"

eval "${remote_env}"
bash -c "${remote_script}"

echo "=== deploy finished ==="
