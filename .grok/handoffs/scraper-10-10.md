# Scraper 10/10 — implementation

**Scope:** `mini-services/stream-scraper/**` only. No UI/player edits. Port 3030 unpublished.

## 1. CinemaOS empty is not an outage
`resolveCinemaosEntries` `isSuccess` is now `(r) => r != null` (same as Videasy/Vidrock/Vixsrc). Empty array = title miss / success. Outer `withTimeout` null still throws `cinemaos_timeout`.

`resolveCinemaos` itself rethrows timeout / 5xx / network via `provider-outage.ts` so a real outage still opens the circuit.

Test: `providers/circuit.test.ts` + cinemaos 200-empty / 502.

## 2. CinePro probe must not assume HLS
`looksLikeHlsUrl` no longer treats `/v1/proxy` or `cinepro` as HLS. Only `.m3u8` / `mpegurl` in the URL.

`classifyProbeKind` sniffs Content-Type + body (`#EXTM3U`, `application/vnd.apple.mpegurl`, `video/mp4`, `ftyp`). CinePro `/v1/proxy` of an MP4 probes as progressive (`probe.ok` when bytes ≥ 200).

Test: `probe-hls-url.test.ts` (URL classify + live Bun.serve MP4 proxy).

## 3. API providers surface real outages
Shared helper `providers/provider-outage.ts`:
- HTTP ≥ 500 → `ProviderOutageError` (`*_http_5xx`)
- abort / timeout → `*_timeout`
- fetch network throw → `*_network`
- 200 empty JSON / 4xx → `[]` (title miss, circuit success)

Applied to **vixsrc, videasy, vidrock, notorrent** (and cinemaos so item 1 is not undermined). Videasy still keeps a 200 sibling if one server 5xxs; all-5xx with no 200 throws.

Tests: one per provider + shared helper.

## 4. Skip Playwright when API roster is healthy
After the API wave, if `countMeasuredPlayableRosterSources >= VERIFIED_MIN_SKIP_SECONDARY` (4), **skip primary PW too** (not just secondary).

Reason (commented in `roster-health.ts` / `index.ts`): Vidking PW is often ~17s and burns the only browser (pool size 1). Witcher S1E1: Luna + Quasar + Rock×3 in 921ms fast / 14s full.

Helper: `shouldSkipPlaywrightForHealthyRoster`. Vidrock is never skipped on the API race.

## 5. Anime coverage (no new hosts)
- `/scrape` and `/prefetch` accept `contentClass=anime` or TV `anime=1`.
- Ranking changes default `streamUrl`, so the class is in `resultCacheKey` (`…:q2160:anime:full`). Not request-local-only.
- `default-source-rank.ts` `animeProviderBoost`: Vidrock + NoTorrent win ties; height/probe still dominate (1080 Luna still beats 720 Rock).
- No Nyaa/Torrentio/Anixtv/Consumet. No new secrets.

## Tests
```
cd /Users/husnainali/cinehome
bun test mini-services/stream-scraper
```
**288 pass, 0 fail.**

## Deploy
Parent deploys. Container code is not live until:
```
ssh hussyserver 'docker exec cinehome curl -sf http://127.0.0.1:3030/health'
ssh hussyserver 'docker exec -e SKIP_FULL=1 cinehome bun /app/scripts/smoke-playback.ts'
```
