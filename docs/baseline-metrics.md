# Baseline metrics — PR-01 / M0

> Historical scraper-only baseline from 2026-07-08. For browser TTFF, delivered
> decoder dimensions, seek, rebuffer, source identity, and failure recovery,
> use `docs/OWNERSHIP-LOG-2026-07-25.md` and the latest dated ownership log.

Smoke harness records **scraper-side** marks only (no browser TTFF).

Canonical fixture: **The Witcher** S1E1 — `tmdbId=71912`, `mediaType=tv`, `season=1`, `episode=1`.

## How to re-run

Inside the production container (scraper listens on `127.0.0.1:3030` only):

```bash
docker exec cinehome bun /app/scripts/smoke-playback.ts
```

Cold / re-enrich (bypass result cache — needed for latency deltas vs capture A):

```bash
docker exec -e NOCACHE=1 cinehome bun /app/scripts/smoke-playback.ts
```

Pre-bake (script not yet in the image) — pipe via stdin:

```bash
docker exec -i cinehome bun - < scripts/smoke-playback.ts
# cold:
docker exec -i -e NOCACHE=1 cinehome bun - < scripts/smoke-playback.ts
```

From a developer machine via SSH:

```bash
ssh -o BatchMode=yes hussyserver \
  'docker exec cinehome bun /app/scripts/smoke-playback.ts'
```

Curl-only fast scrape (if the script is not yet in the image):

```bash
ssh -o BatchMode=yes hussyserver \
  'docker exec cinehome curl -sS --max-time 90 \
    "http://127.0.0.1:3030/scrape?tmdbId=71912&mediaType=tv&season=1&episode=1&fast=1"'
# cold:
ssh -o BatchMode=yes hussyserver \
  'docker exec cinehome curl -sS --max-time 90 \
    "http://127.0.0.1:3030/scrape?tmdbId=71912&mediaType=tv&season=1&episode=1&fast=1&nocache=1"'
```

Local (from repo root):

```bash
bun run smoke:playback
# or: NOCACHE=1 bun run smoke:playback
```

Env:

| Var | Default | Meaning |
|-----|---------|---------|
| `SCRAPER_URL` | `http://127.0.0.1:3030` | Scraper base (trailing `/scrape` stripped) |
| `NOCACHE=1` | off | Append `nocache=1` on fast and full — cold / re-enrich path |
| `SKIP_FULL=1` | off | Skip the second (full) scrape call |
| `FORMAT` | `both` | `table` \| `json` \| `both` |

**Full after fast without `NOCACHE`:** the second call is almost always a **result-cache hit** (~1ms). It does **not** await background multi-provider enrich (`scheduleBackgroundEnrich`). Report field `scrape_full_mode` is `cache_followup` in that case, or `re_enrich` when `NOCACHE=1`. Do not treat warm `scrape_full_ms ≈ 1` as enrich wall time.

**Not the scraper:** host `http://100.89.184.84:4445` is the Next app (SMOKE_BASE-style URLs). Use in-container `3030` for scrape smoke.

## How to compare (operator rules)

Never mix cold and warm numbers. Pick one class and stick to it for a PR delta.

| Goal | Comparison class | Method | Baseline mark |
|------|------------------|--------|---------------|
| Fast-path latency | `cold_fast` | Capture A method, **or** harness with `NOCACHE=1` / fresh scraper process | capture A `scrape_fast_ms ≈ 1485` |
| Multi-source presence after enrich | `warm_cached` / post-enrich | Capture B style (warm, no nocache) after background enrich has run | capture B `scrape_sources = 3` |
| Full re-enrich wall time | `cold_full` | Harness `NOCACHE=1` without `SKIP_FULL` (`scrape_full_mode=re_enrich`) | *not in PR-01 baseline* — measure when needed |

Rules:

1. **Cold latency** → compare only to capture A (or a new row with `comparison_class: cold_fast` / `nocache=yes`). Warm harness runs (`scrape_fast_ms ≈ 1`) are **not** latency regressions or improvements.
2. **Multi-source** → warm or post-enrich (capture B). Cold fast often returns Luna-only (`sources=1`) by design.
3. **Never mix** warm smoke vs cold curl for a single delta claim.
4. When logging a new capture row, note `nocache` / `comparison_class: cold_fast | warm_cached | cold_full`.

## Capture log

| Field | Value |
|-------|--------|
| Date (UTC) | 2026-07-08 |
| Machine | hussyserver (Linux 6.8.0-134-generic x86_64) |
| Container | `cinehome` image `cinehome-cinehome` (created 2026-07-08T21:34:17Z) |
| Operator host | Husnains-MacBook-Air (darwin arm64) |

### A — curl cold-ish fast path (PR-01 baseline marks)

Method: `ssh hussyserver 'docker exec cinehome curl -sS --max-time 90 …'` at ~22:15Z.  
`comparison_class: cold_fast` · `nocache: implicit (cold process / uncached key)`

| Mark | Value | Notes |
|------|-------|--------|
| health | ok | `{"ok":true,"browsers":2,"queued":0}` |
| `scrape_fast_ms` | **1485** | curl `%{time_total}` = 1.484772s |
| `scrape_sources` (fast) | **1** | Luna only at return |
| providers (fast) | Vixsrc | |
| labels (fast) | Luna | |
| streamUrl present (fast) | **yes** | signed URL omitted |
| `scrape_full_ms` | **1** | 0.001357s — **cache follow-up** immediately after fast (not enrich) |
| `scrape_full_sources` | **1** | same entry at that instant |
| pass | **PASS** | health ok + ≥1 source + streamUrl |

```text
fast:  HTTP 200  time_total=1.484772s  sources=1  provider=Vixsrc  label=Luna  streamUrl=yes
full:  HTTP 200  time_total=0.001357s  sources=1  provider=Vixsrc  label=Luna  streamUrl=yes  (cache_followup)
```

**Primary PR-01 baseline for cold latency deltas:** use **capture A** `scrape_fast_ms ≈ 1485`. Reproduce with curl cold process or harness `NOCACHE=1`.

### B — smoke-playback.ts (warm cache after enrich)

Method: `ssh hussyserver 'docker exec -i cinehome bun -' < scripts/smoke-playback.ts` at 2026-07-08T22:16:01Z (stdin; script not yet baked into image).  
`comparison_class: warm_cached` · `nocache: no`

| Mark | Value | Notes |
|------|-------|--------|
| health_ms | 10 | ok, browsers=1 |
| `scrape_fast_ms` | **1** | warm cache — **not** comparable to A for latency |
| `scrape_sources` | **3** | post-enrich multi-provider presence |
| providers | Vixsrc, Vidking, NoTorrent | |
| labels | Luna, Solstice, Pulse | |
| streamUrl | yes | |
| `scrape_full_ms` | **1** | cache follow-up, not enrich wall time |
| `scrape_full_sources` | **3** | |
| pass | **PASS** | harness exit 0 |

Use **B** for multi-source presence checks only, not for `scrape_fast_ms` deltas.

## Empty template (next capture)

| Date (UTC) | Machine | comparison_class | nocache | scrape_fast_ms | scrape_sources | providers | labels | streamUrl | scrape_full_ms | scrape_full_sources | Notes |
|------------|---------|------------------|---------|----------------|----------------|-----------|--------|-----------|----------------|---------------------|-------|
|            |         | cold_fast / warm_cached / cold_full | y/n |                |                |           |        |           |                |                     |       |

## Historical out of scope for PR-01

| Mark | Status |
|------|--------|
| `ttff_ms` (Play → first frame) | Captured by the ownership browser harness after this historical baseline |
| Authenticated browser smoke | Required by the current release gate |
| Proxy hit rate | PR-03 |
