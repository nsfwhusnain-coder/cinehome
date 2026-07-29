#!/usr/bin/env bash
# Create a protected, self-verifying CineHome production rollback snapshot.
set -euo pipefail

EXPECTED_ROOT="/home/hussy/cinehome"
ROOT="${CINEHOME_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
ROOT="$(cd "${ROOT}" && pwd -P)"
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-/home/hussy/cinehome-backups}"
SNAPSHOT_LABEL="${1:-predeploy}"

if [[ "${ROOT}" != "${EXPECTED_ROOT}" ]]; then
  echo "ERROR: snapshots must run from ${EXPECTED_ROOT} (got ${ROOT})." >&2
  exit 1
fi
if [[ ! "${SNAPSHOT_LABEL}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "ERROR: snapshot label contains unsafe characters: ${SNAPSHOT_LABEL}" >&2
  exit 1
fi
if [[ "$(git -C "${ROOT}" branch --show-current)" != "main" ]]; then
  echo "ERROR: production snapshot requires the authoritative main branch." >&2
  exit 1
fi
if [[ -n "$(git -C "${ROOT}" status --porcelain --untracked-files=all)" ]]; then
  echo "ERROR: production snapshot requires a clean authoritative tree." >&2
  exit 1
fi
if ! docker inspect cinehome >/dev/null 2>&1; then
  echo "ERROR: live cinehome container is unavailable." >&2
  exit 1
fi
container_health="$(
  docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    cinehome
)"
restart_count="$(docker inspect --format '{{.RestartCount}}' cinehome)"
oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' cinehome)"
if [[ "${container_health}" != "healthy" ]] \
  || [[ "${restart_count}" != "0" ]] \
  || [[ "${oom_killed}" != "false" ]] \
  || ! curl -sf --max-time 3 http://127.0.0.1:4445 >/dev/null \
  || ! docker exec cinehome curl -sf --max-time 3 \
    http://127.0.0.1:3030/health >/dev/null; then
  echo "ERROR: refusing to snapshot an unhealthy/restarted/OOM runtime." >&2
  exit 1
fi

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_dir="${SNAPSHOT_ROOT}/${timestamp}-${SNAPSHOT_LABEL}"
if [[ -e "${snapshot_dir}" ]]; then
  echo "ERROR: refusing to overwrite snapshot ${snapshot_dir}." >&2
  exit 1
fi
mkdir -p -m 0700 "${snapshot_dir}"/{config,database,docker,git,restore-rehearsal}

live_image_id="$(docker inspect --format '{{.Image}}' cinehome)"
docker image inspect "${live_image_id}" >/dev/null
rollback_tag="cinehome-cinehome:snapshot-${timestamp}"
if docker image inspect "${rollback_tag}" >/dev/null 2>&1; then
  echo "ERROR: refusing to overwrite rollback tag ${rollback_tag}." >&2
  exit 1
fi
docker image tag "${live_image_id}" "${rollback_tag}"

printf 'created_utc=%s\ncommit=%s\nbranch=%s\nimage_id=%s\nrollback_tag=%s\nhealth=%s\nrestarts=%s\noom_killed=%s\n' \
  "${timestamp}" \
  "$(git -C "${ROOT}" rev-parse HEAD)" \
  "$(git -C "${ROOT}" branch --show-current)" \
  "${live_image_id}" \
  "${rollback_tag}" \
  "${container_health}" \
  "${restart_count}" \
  "${oom_killed}" \
  > "${snapshot_dir}/MANIFEST"

for config_path in .env docker-compose.yml Dockerfile start.sh Caddyfile; do
  if [[ -f "${ROOT}/${config_path}" ]]; then
    cp -- "${ROOT}/${config_path}" "${snapshot_dir}/config/${config_path##*/}"
  fi
done
docker compose -f "${ROOT}/docker-compose.yml" \
  --project-directory "${ROOT}" config \
  > "${snapshot_dir}/config/compose.resolved.yml"

docker inspect cinehome > "${snapshot_dir}/docker/container.inspect.json"
docker image inspect "${live_image_id}" > "${snapshot_dir}/docker/image.inspect.json"
docker image ls --no-trunc --digests > "${snapshot_dir}/docker/image-list.txt"
docker logs --tail 500 cinehome > "${snapshot_dir}/docker/container.log" 2>&1
docker image save -o "${snapshot_dir}/docker/image.tar" "${live_image_id}"

git -C "${ROOT}" status --short --branch > "${snapshot_dir}/git/status.txt"
git -C "${ROOT}" log -20 --decorate --oneline > "${snapshot_dir}/git/log.txt"
git -C "${ROOT}" bundle create "${snapshot_dir}/git/cinehome.bundle" --all
git -C "${ROOT}" bundle verify "${snapshot_dir}/git/cinehome.bundle" \
  > "${snapshot_dir}/git/bundle-verify.txt" 2>&1

database_count=0
while IFS= read -r -d '' database_path; do
  resolved_database="$(realpath "${database_path}")"
  case "${resolved_database}" in
    "${ROOT}/db/"*) ;;
    *)
      echo "ERROR: database resolved outside ${ROOT}/db: ${resolved_database}" >&2
      exit 1
      ;;
  esac

  database_name="$(basename "${resolved_database}")"
  snapshot_database="${snapshot_dir}/database/${database_name}"
  sqlite3 "${resolved_database}" ".backup '${snapshot_database}'"
  if [[ "$(sqlite3 -readonly "${snapshot_database}" 'PRAGMA quick_check;')" != "ok" ]]; then
    echo "ERROR: SQLite quick_check failed for ${database_name}." >&2
    exit 1
  fi

  printf 'database=%s quick_check=ok sha256=%s\n' \
    "${database_name}" \
    "$(sha256sum "${snapshot_database}" | awk '{print $1}')" \
    >> "${snapshot_dir}/database/integrity.txt"

  for table in User UserSetting WatchlistItem WatchProgress AppSetting CachedStream; do
    if [[ "$(sqlite3 -readonly "${snapshot_database}" \
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${table}';")" != "1" ]]; then
      continue
    fi
    row_count="$(sqlite3 -readonly "${snapshot_database}" \
      "SELECT count(*) FROM \"${table}\";")"
    row_fingerprint="$(
      sqlite3 -readonly -batch -noheader "${snapshot_database}" \
        "SELECT * FROM \"${table}\" ORDER BY rowid;" \
        | sha256sum | awk '{print $1}'
    )"
    printf '%s count=%s sha256=%s\n' \
      "${table}" "${row_count}" "${row_fingerprint}" \
      >> "${snapshot_dir}/database/table-fingerprints.txt"
  done

  rehearsal_database="${snapshot_dir}/restore-rehearsal/${database_name}"
  sqlite3 "${rehearsal_database}" ".restore '${snapshot_database}'"
  if [[ "$(sqlite3 -readonly "${rehearsal_database}" 'PRAGMA quick_check;')" != "ok" ]]; then
    echo "ERROR: restored rehearsal copy failed for ${database_name}." >&2
    exit 1
  fi
  database_count=$((database_count + 1))
done < <(find "${ROOT}/db" -maxdepth 1 -type f -name '*.db' -print0)

if (( database_count == 0 )); then
  echo "ERROR: no SQLite database was found under ${ROOT}/db." >&2
  exit 1
fi

(
  cd "${snapshot_dir}"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)
chmod -R go-rwx "${snapshot_dir}"

echo "snapshot OK: ${snapshot_dir}"
echo "rollback image: ${rollback_tag} -> ${live_image_id}"
