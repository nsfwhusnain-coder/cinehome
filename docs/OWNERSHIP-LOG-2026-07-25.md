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

The application change has not yet been deployed at this log point.
