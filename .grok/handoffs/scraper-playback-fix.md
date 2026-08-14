# Scraper playback-fix — embed identity

**Scope:** `mini-services/stream-scraper/**` only. No player/debrid. No new providers.

## 1. Duration / trailer gate

Shared `assessMediaDuration` already rejected a 15 min clip vs an 80 min movie (40% floor + 15 min shortfall). That is now locked in the scraper so it cannot regress if the helper is loosened.

- New `embed-duration.ts`: `isImplausibleEmbedDuration`
  - **Movie expected ≥80 min** and observed **≤15 min** → reject (trailers/samples)
  - Alternate cuts (65–90 min vs 120) stay
  - TV uses the shared helper only — **~20 min episodes** and **specials vs a longer series average** stay
- `probe.ts` `applyDurationExpectation` calls this helper. Unknown/non-finite durations still fail open (`!= null` / `Number.isFinite`).
- Tests: `embed-duration.test.ts` + `probe-duration.test.ts` (15 min vs 80 min movie rejected; 20 min TV kept).

## 2. Trailer / sample / preview never auto-default

Existing PW drop was `url.includes("preview"|"trailer")`. That is now a shared marker and a rank gate.

- `isPreviewOrSampleUrl` — path/query/hash tokens `trailer` / `preview` / `sample`. **Not host blocks.** `SAMPLE-AES` stripped first.
- `isPreviewOrSampleLabel` — same tokens on title/label (`Official Trailer`).
- `isNeverAutoDefaultUrl` is now a **superset of poison** (the comment’s intended expansion). `isPoisonStreamUrl` unchanged (player mirror stays valid for abuse/php).
- Rank / pick / score / provider priority / roster-health / early-exit / quality reserve all use never-auto-default.
- `isValidStreamUrl` uses `isPreviewOrSampleUrl` (PW still drops these).
- `buildMergedResult` stamps `verified: false` on blocked embeds so client ranking also will not auto-pick them when a clean verified row exists.
- Last resort: if every candidate is a trailer, one URL is still returned (same as poison).

## Tests

```
cd /Users/husnainali/cinehome
bun test mini-services/stream-scraper
```

**301 pass, 0 fail.**

## Deploy

Parent deploys. Container code is not live until:

```
ssh hussyserver 'docker exec cinehome curl -sf http://127.0.0.1:3030/health'
ssh hussyserver 'docker exec -e SKIP_FULL=1 cinehome bun /app/scripts/smoke-playback.ts'
```
