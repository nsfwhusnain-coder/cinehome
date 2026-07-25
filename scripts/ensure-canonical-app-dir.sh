#!/usr/bin/env bash
# Next.js prioritizes ./app over ./src/app (see next/dist/lib/find-pages-dir.js).
# Canonical App Router is src/app. A stale root app/ shadows it and breaks prerender
# (e.g. layout importing removed MobileBottomNav → "Element type is invalid... undefined").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STALE="${ROOT}/app"
CANONICAL="${ROOT}/src/app"

if [[ ! -d "$CANONICAL" ]]; then
  echo "error: canonical App Router missing at src/app" >&2
  exit 1
fi

if [[ -d "$STALE" ]]; then
  echo "warning: removing stale root app/ so Next.js uses src/app (root app shadows src/app)" >&2
  rm -rf "$STALE"
fi
