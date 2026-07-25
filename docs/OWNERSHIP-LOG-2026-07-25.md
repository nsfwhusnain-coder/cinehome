# CineHome ownership log — 2026-07-25

This is the running production-owner record for the 2026-07-25 reliability
and product-quality pass. Times are UTC unless stated otherwise. Source URLs,
tokens, PINs, cookies, and environment values are deliberately excluded.

## Source of truth decision

- The deployed host tree, `/home/hussy/cinehome`, had no Git history.
- The previously documented Mac canonical tree was not available from this
  workstation.
- Before any application code was edited, the host tree was compared with the
  running container's build-critical tree. Their deterministic SHA-256
  manifest hash matched:
  `2158497c60b446d2783d75b4849d740681ebddeeb918a953b3b6dba17d7762ff`.
- Git was initialized deliberately on the deployed host tree. Baseline commit:
  `11847dd94228e43179a9d0e6541b3221288f3b80`, branch `main`, tag
  `production-baseline-20260725`.
- Decision: the server Git repository is the temporary canonical source and
  deployment tree. If the old Mac repository returns, its history must be
  reconciled into this repository; it must never be rsynced over production.
- A working clone was made at `C:\Users\husna\projects\cinehome`.

## Rollback snapshot and restore proof

- Snapshot: `/home/hussy/cinehome-backups/20260725T105000Z-baseline`
- Snapshot permissions: directories `0700`, files `0600`.
- Contents include SQLite online backups, environment/config copies, original
  and resolved Compose configuration, Dockerfile/start/Caddy configuration,
  Git bundle, image/container inspection data and logs, the full Docker image
  archive, and checksums.
- Immutable rollback image tag:
  `cinehome-cinehome:rollback-20260725T105000Z`.
- Verified before the first application change:
  checksums, SQLite integrity, application row counts, Compose resolution, Git
  bundle, and image archive.
- Restore rehearsal: restored copies were started in an isolated container.
  The app returned the expected login redirect, scraper health passed five
  consecutive checks, and restored database counts matched. The rehearsal
  container was removed; the restored data copy remains at
  `/home/hussy/cinehome-restore-rehearsal`.

## Production baseline

Harness:

```bash
docker exec \
  -e STORAGE_STATE=/tmp/cinehome-baseline-storage.json \
  -e CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell \
  cinehome bun /app/scripts/browser/ownership-baseline.ts all
```

The harness requires authenticated browser playback and treats a source as
successful only after decoded dimensions are present and the playhead advances.
It records actual decoder properties, seek recovery, response classes, and
forced source death. Its checked-in implementation strips media URLs from the
JSON report.

### Resolution sample

Report:
`.browser-qa/ownership-baseline/baseline-resolution-2026-07-25T11-37-20-747Z.json`

- 21 fixtures: current movies, classics, older and obscure movies,
  international titles, current series, long-running series, and anime.
- App playback API: 21/21 available.
- Debrid source present: 20/21. `Detectorists S1E1` was the exception and had
  one 720p embed source.
- Fast API response, all per-user cache misses: p50 3,653 ms; p95 5,684 ms.
- Full API response: p50 9,023 ms; p95 11,841 ms. Twenty were per-user cache
  misses and one was a hit.
- Full source count ranged from 1 to 15.
- The direct scraper's `nocache=1&fast=1` result is **not a valid cold
  measurement**. The fast branch ignores `nocache`, and the health endpoint
  reports the latest provider attempt rather than a request-scoped trace.
- Distinct provider-attempt timestamps in the run: Vixsrc 19, VidLink 19,
  NoTorrent 19, CinemaOS 19, Playwright 13, CinePro 4. All four CinePro
  attempts hit its 8,000 ms timeout; the circuit then opened. These counts are
  diagnostic, not title-level hit rates.

### Browser playback sample

Reports:

- `.browser-qa/ownership-baseline/baseline-playback-2026-07-25T11-42-45-422Z.json`
- `.browser-qa/ownership-baseline/baseline-playback-2026-07-25T11-30-54-138Z.json`
  (isolated failed-recovery reproduction)

Eight real playback runs covered movies, episodes, an obscure title, anime,
two warm repeats, two seeks, and two forced-failure repetitions:

- First-frame success: 8/8.
- Cold click-to-first-frame: p50 5,664 ms; p95 8,163 ms.
- Warm click-to-first-frame: Fight Club 3,050 ms; Witcher S1E1 3,255 ms.
- The API-advertised top-ranked source was the source actually attached in
  only 3/8 runs.
- Decoded first frame was 1920-wide in 8/8 runs. `Coherence` correctly decoded
  at the content-aspect 1920x816; the other seven decoded at 1920x1080.
- Seek recovery: Fight Club cold 519 ms, Fight Club warm 772 ms, Witcher cold
  4,091 ms, Witcher warm 781 ms.
- Rebuffer/waiting signal: 3/8 runs during the ten-second observation.
- Forced active-source death recovered in 2/3 total repetitions. Successful
  recovery took 8,415 ms and 5,923 ms. The isolated failure did not recover in
  40 seconds and ended with no dimensions, no duration, readyState 0, and no
  replacement source.
- Both successful Fight Club failovers changed from an advertised 1080p DASH
  source to an advertised 1080p progressive source that actually decoded at
  1282x534. This is a concrete metadata-versus-delivery quality defect.

## Confirmed root causes before first code change

1. The DASH path depends on dash.js's terminal `ERROR` event. Repeated hard
   segment HTTP failures can leave dash.js stalled without that event. The
   engine-agnostic watchdog only calls `play()` forever and is explicitly
   forbidden from failing over, explaining the nondeterministic 2/3 recovery.
2. Player source failure callbacks are not bound to an attach generation.
   Late callbacks from a destroyed engine can act on the current source through
   mutable refs, so source identity is not race-safe.
3. Source selection happens independently in the scraper, playback API, and
   player. This produces observable default/attached identity disagreement and
   makes ranking behavior difficult to explain.
4. The scraper full path launches providers independently but then awaits
   CinePro, Luna, and CinemaOS as one `Promise.all` gate. A dead CinePro arm can
   consume its full timeout even when another provider is already usable.
5. Fast `nocache=1` does not bypass the scraper result cache. Full `nocache=1`
   only bypasses when the cached roster is below its cap. Existing documentation
   describes this as a cold measurement when it is not.

## Change log

### Player attempt lifecycle (pending deploy)

- Added `src/lib/playback/source-attempt.ts`, a single engine-independent
  controller for source attachment identity and terminal failure ownership.
- Every media attachment now has a source ID plus a monotonically increasing
  generation. Source transitions and teardown invalidate the previous attempt
  before engine/XHR abort callbacks can fire.
- Late callbacks from a destroyed engine are ignored. Only one terminal
  callback can claim a generation, preventing an error storm from skipping
  through multiple healthy fallback sources.
- DASH XHR transport is observed directly because dash.js does not reliably
  emit terminal `ERROR` for repeated segment failures. Two hard transport
  failures without playback progress now fail over. Intentional status-0 aborts
  caused by seeking or teardown do not count.
- The engine-independent playhead watchdog permits one recovery nudge. A
  second 12-second window without progress fails over; real progress resets
  both the stall and hard-transport budgets.
- Failure reasons are emitted as structured `[playback-failure]` browser
  console records without source URLs.

Verification before deploy:

- New attempt-controller unit tests: 6 passed, 0 failed.
- Playback library tests: 204 passed, 0 failed, 431 expectations.
- Isolated production image build: passed.
- Repository-wide `tsc --noEmit`: the only failures are two pre-existing
  `typeof fetch` mock casts in `src/lib/debrid-credentials.test.ts` lines 88
  and 100. No changed file produced a type error.
- Focused ESLint reaches existing `video-player.tsx` React 19 lint debt
  (render-time ref mirroring and synchronous effect state). No new lint class
  was introduced; that pre-existing debt remains to be resolved separately.

Deployment:

- Authoritative commit: `8776bd192f010669f301254cd772c525e0832e8c`.
- Production image:
  `sha256:8f33394c7a1d70410b7582da3cafb64c99a0f18b3dae1ca07e256519a183a212`.
- Checked-in deploy script completed its disk preflight (217.5 GiB free),
  image build, container replacement, internal scraper health, and published
  HTTP health check.
- Post-deploy database integrity remained `ok`. Users stayed at 13 and
  watchlist rows at 17. Progress rose from 79 to 82 and cached streams from
  66 to 115 due to the authenticated baseline runs themselves.
- Two post-deploy generic forced-death runs recovered (2/2). Warm recovery was
  2,805 ms; the cold run took 26,105 ms, which is too slow and is still under
  investigation rather than being claimed as complete.

### Server identity collision

The deterministic DASH-selection smoke exposed seven distinct CinemaOS rows
all rendered with the same Greek name, `Eos`. The first-word-only label parser
collapsed `Cinema AR 1080`, `Cinema FR 1080`, and every peer to one identity;
`Eos` also collided with Vixsrc/Luna. This made the UI ambiguous and prevented
deterministic source selection.

- Server identity now strips quality words/numbers but preserves meaningful
  label suffixes: `Cinema AR 1080` becomes semantic token `cinema-ar`.
- Generic CinemaOS `Cinema` gets a separate `cinema-main` token.
- The current seven CinemaOS variants produce seven stable, distinct Greek
  names and none collides with Luna.
- Quality enrichment (`Cinema AR 720` → `Cinema AR 1080`) does not rename the
  logical server.
- Server-name plus attempt-controller focused tests: 21 passed, 0 failed.
- Deployed as authoritative commit
  `035f9c176ca0c80865654424ecc78b7cf88fb050`; production image
  `sha256:f7bf15a2c657d3e93505b83de8dbca3d1117edb187389b85171a9e3b18ddb111`.
- Post-deploy health was green, SQLite integrity remained `ok`, and the data
  invariants remained 13 users / 17 watchlist / 82 progress rows.

### Source fan-out and false DASH health (pending deploy)

The first deterministic post-identity DASH run found a deeper availability
failure:

- CinemaOS `Cinema AR 1080` was selected by the full resolver as its measured
  default, but never produced a frame. The player correctly failed it and
  moved through Luna to a third server.
- The DASH probe's `firstDashMediaUrl` rejected any ordinary
  `$RepresentationID$`, `$Number$`, `$Bandwidth$`, or `$Time$` template. It
  then fell back to requesting the MPD itself and counted the XML bytes as a
  successful media segment. This was the reason a dead DASH source could beat
  a working HLS source.
- The fallback debrid source reported a 30.058-second duration for a feature
  film. Resume-to-1,200-seconds clamped immediately to its end, so it is not a
  valid recovery. That remains an active quality-path defect, not a passing
  failover.

The source-resolution change under verification:

- Expands standard DASH templates and probes a real first media URL. An
  unresolved MPD is now `dash_media_unresolved`, never a false success.
- Replaces the full path's
  `Promise.all(CinePro, Luna, CinemaOS)` gate with independent provider arms:
  first useful result plus a 2.5-second quality grace, 7.5-second hard wall,
  and additive late-result cache enrichment.
- Emits request-keyed provider outcomes with provider, status, count, latency,
  and whether the result arrived after the response.
- Fixes an enrichment race that was observed collapsing a 19-source cache back
  to the five-source snapshot taken when browser enrichment began.
- Makes `nocache=1` a genuine fresh resolve for fast and full requests instead
  of silently returning the cache when it was full or when `fast=1`.
- Reduces raw and per-user signed-source cache TTLs from 20 minutes to three
  minutes. Partial cache TTL is 1.5 seconds and playback fetches are `no-store`,
  so the existing two-second progressive poll can see late results instead of
  replaying a cached partial response for 45–120 seconds.

Verification so far:

- New provider-race and DASH-template tests: 9 passed.
- Entire scraper suite: 168 passed.
- Playback/proxy/debrid suite: 233 passed.
- Production build passed.
- `tsc --noEmit` has no new errors; only the two pre-existing
  `debrid-credentials.test.ts` fetch-cast errors remain.

Deployment and first measurement:

- Deployed as authoritative commit
  `4fb9405cad79ddb97a7a10be3ab4ab346dd823ab`; production image
  `sha256:1367afa1cfeca4b9f13cda0786218ff45a2581359fb6ab27577c394874bbf2fd`.
- Post-deploy health, SQLite integrity, and user invariants passed: 13 users,
  17 watchlist rows, 82 progress rows, 115 cached debrid streams.
- Fresh eight-film sample (mainstream, new releases, classics, international,
  obscure): 8/8 API resolution and 8/8 with debrid.
- Full resolution improved from the 21-title baseline p50 9,023 ms / p95
  11,841 ms to p50 6,470 ms / p95 8,284 ms in the first post-change
  eight-title slice. This is a 28.3% p50 and 30.0% p95 reduction. The slowest
  item was still 12,964 ms and remains under investigation.
- The repaired direct cold-fast path (now genuinely bypassing cache) measured
  p50 3,670 ms / p95 4,510 ms across those eight titles.
- Seven of eight full responses now defaulted to working Luna HLS rather than
  the previously false-positive CinemaOS DASH. Coherence exposed one real
  480p DASH source whose expanded media segment passed the new probe; it is
  being exercised separately through the real player.

### Accessible row identity

Coherence also exposed two CinemaOS quality variants sharing the same friendly
Greek server name. The visible resolution badges distinguished the rows, but
their accessible names did not and automation could not address either row
unambiguously. Server rows now expose their stable source ID in
`data-source-id`, and their accessible label includes friendly name, quality,
and live/failure state. Names remain stable while row identity is exact.

- Deployed as authoritative commit
  `544a5a318305f4a07cad672e73f3c520953ef160`; production image
  `sha256:a5650ee118d0ec64c545a66db7d38d8a71e57033c11903982a327aff1ab3e2bf`.
- Post-deploy service health and user invariants remained clean.

### CinemaOS worker quarantine (pending deploy)

The exact Coherence row could then be exercised twice. Both runs reproduced
the same transport sequence: CinemaOS MPD HTTP 200, followed by HTTP 429 from
`bcdn.hakunaymatata.com` during dash.js's first real media burst, then
generation-safe failover to Luna. Fight Club's worker DASH had already failed
the same way. The source was therefore a provider-path failure, not a player
lifecycle race.

Direct inspection of the current CinemaOS roster showed the useful distinction:

- Direct `hcdn.hakunaymatata.com` / `macdn.hakunaymatata.com` sources returned
  ranged `video/mp4` with an `ftyp` box.
- `ffprobe` on Coherence's top direct source confirmed H.264/AAC,
  1920x816, 5,286.3 seconds, and 1.54 GB: real feature content, not a trailer.
- The `*.cinemaos.workers.dev` fallback returned DASH XML and its bcdn child
  rate-limited under actual playback.

The provider now quarantines only the reproducibly broken worker fallback
before it enters fast/full rosters, while retaining the verified direct MP4
sources. The smoke report now records only safe upstream host and path kind
(never token or URL) for per-hop transport diagnosis.
