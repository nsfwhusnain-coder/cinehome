#!/usr/bin/env bash
# Runtime cutover/rollback helpers. This file is sourced by deploy.sh.

wait_for_runtime_health() {
  local timeout_seconds="$1"
  local health_deadline=$((SECONDS + timeout_seconds))
  local poll_interval="${HEALTH_POLL_INTERVAL_SECONDS:-2}"
  while (( SECONDS < health_deadline )); do
    container_health="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        cinehome 2>/dev/null || true
    )"
    restart_count="$(docker inspect --format '{{.RestartCount}}' cinehome 2>/dev/null || true)"
    oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' cinehome 2>/dev/null || true)"

    app_ok=0
    scraper_ok=0
    if curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}" \
      "${DEPLOY_HEALTH_URL}" >/dev/null 2>&1; then
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
    sleep "${poll_interval}"
  done
  return 1
}

rollback_live_image() {
  if [[ -z "${predeploy_tag:-}" ]] || [[ -z "${live_image_id:-}" ]]; then
    echo "ERROR: predeploy tag/image identity is unavailable for rollback." >&2
    return 1
  fi

  echo "ROLLBACK: restoring ${predeploy_tag}" >&2
  if ! docker image tag "${predeploy_tag}" cinehome-cinehome:latest; then
    echo "ERROR: could not retag the predeploy image." >&2
    return 1
  fi
  if ! docker compose up -d --no-deps --force-recreate --no-build cinehome; then
    echo "ERROR: Compose could not recreate CineHome from the predeploy image." >&2
    return 1
  fi

  restored_image_id="$(
    docker inspect --format '{{.Image}}' cinehome 2>/dev/null || true
  )"
  if [[ "${restored_image_id}" != "${live_image_id}" ]]; then
    echo "ERROR: rollback image mismatch: expected ${live_image_id}, got ${restored_image_id:-missing}." >&2
    return 1
  fi
  if ! wait_for_runtime_health "${ROLLBACK_HEALTH_TIMEOUT_SECONDS:-120}"; then
    echo "ERROR: automatic image rollback did not return to a healthy runtime." >&2
    docker compose ps || true
    docker compose logs --tail=100 cinehome || true
    return 1
  fi

  restored_image_id="$(
    docker inspect --format '{{.Image}}' cinehome 2>/dev/null || true
  )"
  if [[ "${restored_image_id}" != "${live_image_id}" ]]; then
    echo "ERROR: rollback identity changed after health: ${restored_image_id:-missing}." >&2
    return 1
  fi
  echo "ROLLBACK OK: ${predeploy_tag} (${live_image_id}) is healthy again" >&2
}

cutover_rollback_armed=0

handle_cutover_exit() {
  local original_status="${1:-1}"
  trap - EXIT HUP INT TERM

  if [[ "${cutover_rollback_armed}" == "1" ]]; then
    cutover_rollback_armed=0
    if ! rollback_live_image; then
      echo "CRITICAL: automatic rollback failed; production requires immediate operator recovery." >&2
    fi
  fi
  exit "${original_status}"
}

arm_cutover_rollback() {
  cutover_rollback_armed=1
  trap 'handle_cutover_exit $?' EXIT
  trap 'handle_cutover_exit 129' HUP
  trap 'handle_cutover_exit 130' INT
  trap 'handle_cutover_exit 143' TERM
}

disarm_cutover_rollback() {
  cutover_rollback_armed=0
  trap - EXIT HUP INT TERM
}
