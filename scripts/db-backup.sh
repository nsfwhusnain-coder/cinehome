#!/usr/bin/env bash
# Snapshot the live SQLite file without stopping the app.
#
# Uses `sqlite3 .backup` when available so WAL writers cannot produce a torn
# copy. Falls back to copying the db + WAL/SHM files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${DB_PATH:-${ROOT}/db/cinehome.db}"
BACKUP_ROOT="${BACKUP_ROOT:-${ROOT}/db-backups}"
KEEP_LAST="${KEEP_LAST:-7}"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "No SQLite database at ${DB_PATH} — skipping backup"
  exit 0
fi

if ! [[ "${KEEP_LAST}" =~ ^[0-9]+$ ]] || [[ "${KEEP_LAST}" -lt 1 ]]; then
  echo "ERROR: KEEP_LAST must be a positive integer (got: ${KEEP_LAST})" >&2
  exit 2
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_ROOT}/db-${stamp}"
mkdir -p "${dest}"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB_PATH}" ".backup '${dest}/cinehome.db'"
else
  echo "sqlite3 not on PATH — copying db files (WAL-safe .backup unavailable)"
  cp -a "${DB_PATH}" "${dest}/cinehome.db"
  if [[ -f "${DB_PATH}-wal" ]]; then
    cp -a "${DB_PATH}-wal" "${dest}/cinehome.db-wal"
  fi
  if [[ -f "${DB_PATH}-shm" ]]; then
    cp -a "${DB_PATH}-shm" "${dest}/cinehome.db-shm"
  fi
fi

# Newest first; drop anything past KEEP_LAST.
idx=0
while IFS= read -r old; do
  [ -z "${old}" ] && continue
  idx=$((idx + 1))
  if [ "${idx}" -gt "${KEEP_LAST}" ]; then
    echo "prune old backup ${old}"
    rm -rf "${old}"
  fi
done < <(ls -1dt "${BACKUP_ROOT}"/db-* 2>/dev/null || true)

echo "sqlite backup: ${dest}/cinehome.db"
