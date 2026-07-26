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

### CinemaOS worker quarantine

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

- Deployed as authoritative commit
  `87b6ddcdf3eb2302ac07cf2ac2239e7bb6d0ac78`; production image
  `sha256:90b6f170b47fa7861168bbdb3c8d8ab9b18d1d2b9e7ac27b2c45b7043b5e7d40`.
- Live provider verification returned six direct sources, zero worker sources,
  across hcdn/macdn only.
- The retained CinemaOS Coherence MP4 reached a healthy advancing frame in
  1,574–3,557 ms over three exact selections. Chromium reported H.264/AAC,
  1920x816, ~2.33 Mbps, 5,286 seconds, with byte-range support.
- Three forced deaths of that exact progressive source all recovered to Luna
  HLS (3/3). Recovery was 5,385 / 5,749 / 5,757 ms (median 5,749 ms), with the
  replacement advancing at the preserved mid-title position.

### Real-Debrid full-item validation

The quality audit found a concrete false-positive in Fight Club's cached RD
roster. The `native-1080-1` row was selected from a generic movie pack and
advertised as 1080p H.264/MP4, but `ffprobe` measured only 30.058 seconds and
1,184,727 bytes. The other three inspected Fight Club RD rows were genuine
full features: 8,348 seconds at 1.99 GB (1080p), 3.33 GB (1080p), and 7.34 GB
(2160p HEVC). The failure was therefore candidate/file identity, not a player
decode or transcoder issue.

Root cause: both fresh RD resolution and all warm-cache paths treated a
token-free direct URL as sufficient proof of playable media. No boundary
checked the resolved object's size, so a valid CDN response for a short clip
could be cached for 24 hours and repeatedly outrank healthy embeds.

The RD boundary now performs one bounded `bytes=0-0` probe and reads the
object total from `Content-Range` (or a full-response `Content-Length`).
Movies below 50 MiB and episodes below 15 MiB are conclusively rejected;
HTTP failures are rejected too. Origins that do not expose size remain
available and are explicitly classified as indeterminate rather than causing
a validation-induced outage. Validation is single-flighted per direct link
and cached for ten minutes on a measured success, so concurrent fast/full
requests do not duplicate CDN work. Cache, fast-cache, and fresh-candidate
paths all use the same boundary. Rejections emit a structured
`debrid_media_rejected` event with provider, IMDb/slot where known, reason,
status, bytes, and timing, but never a direct URL or credential.

Verification before deployment:

- Focused validation/roster coverage: 12 passed, including the measured
  1.18 MB failure, fresh-candidate fallback, bad warm-row replacement, and
  validation single-flight.
- Entire playback/debrid suite in the production dependency image: 211
  passed, zero failed.
- Production image build passed.
- `tsc --noEmit` produced no new diagnostics; only the two pre-existing
  `debrid-credentials.test.ts` fetch-cast errors remain.

First live deployment and follow-up:

- Deployed as authoritative commit
  `0b807955b5ec24f5fbdcece7be749ea697fedeb1`; production image
  `sha256:374a95cc481dead765dc0b3b68282d4e238fccc5277e206901c834860e911639`.
- A fresh authenticated Fight Club matrix resolved successfully with debrid.
  The structured log conclusively rejected the old cached row at 1,184,727
  bytes, and the DB row self-healed from the generic movie pack to the
  full-length YIFY release without manual deletion.
- The same live run caught other bad 1.18â€“2.12 MB season-pack file selections
  for Attack on Titan, The Office, and The Witcher while ordinary user/home
  prefetches were running. This confirms the defect was systemic and the new
  boundary is protecting real traffic, not only the original fixture.
- That first repair exposed a roster-allocation bug: `native-1080-1` fell
  through to the release already cached in `native-1080-2`, producing two
  source IDs for one URL. Missing 1080p slots now divide only the unoccupied
  ranked candidates into disjoint fallback lanes. Existing duplicate warm
  rows are collapsed, logged as `debrid_duplicate_slot_rejected`, and refilled
  with a distinct release. Resolution remains parallel.
- Focused validation/roster coverage after the allocator change: 13 passed.
  Entire playback/debrid suite: 212 passed, zero failed.
- Live allocator verification improved Fight Club's uncached full response
  from 13,789 ms to 5,926 ms and kept resolution/debrid success at 1/1. It
  also revealed that Torrentio can repeat one info-hash under multiple labels;
  disjoint lanes alone therefore still produced three distinct URLs across
  four cache rows. The unoccupied candidate pool is now deduplicated by
  info-hash (or source URL when no hash exists) before lane allocation.
- Focused coverage is now 14 passed and includes a cold roster containing a
  deliberately repeated Torrentio hash; all five resulting slot URLs must be
  distinct.
- Live verification showed the provider sometimes omits `infoHash` while
  still embedding it in the standard RD resolve-proxy path. Legacy cache rows
  therefore held only direct URLs; different provider filenames could mask
  one underlying hash, and a resolved fallback could redirect back to an
  already-occupied direct object. The parser now recovers only the
  40-character hash from the known resolve path (never the credential
  segment). Allocation dedupes on that stable identity, and the post-resolve
  boundary also rejects an occupied final URL.
- Conclusively bad or duplicate cache rows are now expired immediately before
  replacement is attempted. If the provider exhausts the 12-second budget,
  the stale row stays available for diagnosis but cannot be read as fresh and
  retried forever. Regression coverage includes omitted hashes, different
  filenames for the same hash, legacy URL-only rows, post-redirect duplicate
  rejection, and invalidation when no replacement resolves.
- One more live pass proved that RD can rotate the final direct URL for the
  same legacy release. URL equality therefore cannot bridge every pre-fix row
  to a newly hash-identified candidate. A normalized ASCII release-title key
  now acts as that migration bridge (empty/non-ASCII-only keys are ignored);
  it is used only for deduplication, never as proof that media is healthy.

### Production transcode incident and containment

An exact-browser Fight Club playback pass selected the first debrid MP4 row,
which was the `safari-2160` HEVC/MKV release. The native Luna path itself
reached a real 1920x1080 H.264/AAC frame and advanced continuously, but cold
first frame was 14,144 ms and a mid-title seek took 25,271 ms. The requested
debrid failover never became playable within 30 seconds.

The transcode worker first attempted VAAPI decode/encode for 1080/720/480 and
emitted the AMD DRM error `os_same_file_description couldn't determine if two
DRM fds reference same`. It then fell back to a three-rung software encode of
the entire remote feature. Container load reached 1,378.51% CPU, 17.4 GiB RAM,
and 610 PIDs. Killing the exact QA ffmpeg process did not recover the app:
the Bun/Next process remained at roughly 18.6 GiB RSS and 96% CPU under memory
pressure.

Containment was deliberately exact and reversible:

- killed only the QA ffmpeg process;
- removed only its validated cache key
  `af90f9d74aff20f0fda7615c`;
- restarted the CineHome container on the unchanged production image;
- confirmed it returned healthy at 458.7 MiB, 2.83% CPU, and 369 PIDs;
- rechecked SQLite integrity plus all 13 users, 17 watchlist rows, and 82
  progress rows.

Root cause is architectural: the legacy worker starts a whole-file,
multi-rendition encode without a production-safe memory/concurrency envelope.
This is not repairable with a longer player timeout. Production now defaults
`TRANSCODER_ENABLED=0`; `start.sh` requires an explicit `1`, both authenticated
transcode routes return 503 while disabled, incompatible rows are visibly
labelled and disabled in both server pickers, and auto-selection returns no
default rather than entering the worker. Native-compatible Real-Debrid files
continue to direct-play.

Containment deployment verification:

- authoritative runtime commit:
  `c24512d7d59f4ec07b04e7cf50999adb139f5921`;
- production image:
  `sha256:f6e4a6cf7f074acfd524fd58b81206b554b41dc56c6324fbb14b5f5531582960`;
- full playback/debrid suite: 216 passed, zero failed, 460 assertions;
- production build compiled successfully; `tsc --noEmit` showed only the two
  already-recorded fetch-mock cast diagnostics in
  `debrid-credentials.test.ts`, with no new diagnostic;
- container log confirms the worker is disabled, port 3040 is closed, and no
  ffmpeg/transcoder process exists;
- an authenticated `/api/transcode` request returned the intended 503 before
  source resolution, so a signed-in client cannot recreate the incident;
- exact browser QA expanded all 16 Fight Club server rows and found the
  incompatible 4K debrid row rendered as `4K · unavailable`, accessibility
  labelled `unavailable in this browser`, and natively disabled;
- after deployment: healthy, SQLite `ok`, users 13, watchlist 17, progress 82,
  cached streams 119; idle sample 424.6 MiB, 2.08% CPU, 355 PIDs.

### Real-Debrid playback failure: host DNS

The first exact native-RD probe selected `native-1080-1`, then recorded a
generation-scoped `media_element_error` and recovered to the prior source.
The target never stayed healthy. Direct inspection showed all three cached
Sydney RD download hostnames failing name resolution inside the container.
The failure reproduced on the host itself: general names including Google,
Torrentio, and the RD API all failed through `100.100.100.100`.

`tailscale dns status` reported MagicDNS enabled but no upstream resolvers,
while the physical interface still had `192.168.1.1` and `8.8.8.8`.
Bounded direct queries to `192.168.1.1`, `8.8.8.8`, and `1.1.1.1` all resolved
the affected RD host immediately. An isolated CineHome image using the
proposed explicit resolvers resolved it 5/5.

The project-scoped fix sets Compose DNS to the LAN gateway plus Cloudflare,
both configurable through `CINEHOME_DNS_PRIMARY` and
`CINEHOME_DNS_FALLBACK`. This leaves global Tailscale configuration untouched
while preventing its broken upstream from taking down CineHome's provider and
media lookups. Docker internal service discovery remains available.

### Production OOM: server-side debrid media drains

A forced source-death test caused the Bun/Next process to be killed by the
kernel at approximately 30.1 GiB anonymous RSS. The container restarted once;
SQLite and all user invariants survived. HLS proxy caching was the first
credible suspect because it cloned media responses and prefetched segments.
Two reversible containment commits first bounded the cache and then disabled
in-heap segment body caching:

- `1bb262a` capped entries/readers and disabled HLS prefetch;
- `b1ae04b` stopped teeing segment response bodies into the app heap.

Those changes reduced one source of memory amplification but did not stop the
growth. An idle control stayed flat near 162 MiB Next RSS. One resolver-only
request, with no player or HLS media request, then took Next above 4.3 GiB and
still rising. Running `resolveDebridSources` in its own Bun process isolated
the fault further: it returned four rows in about 1.35 seconds, then climbed
past 1.4 GiB during the following twelve seconds.

There were two root causes at the debrid boundary:

1. Torrentio resolution used `redirect: "follow"`, so the server followed the
   small resolver redirect onto the final multi-gigabyte Real-Debrid object
   merely to learn `response.url`.
2. Range validation read the headers and called only
   `response.body.cancel()`. When an origin ignored `Range: bytes=0-0`, Bun
   continued draining the response asynchronously.

Commit `8539982` changes resolver fetches to one manual redirect, returns only
the sanitized token-free `Location`, and aborts the fetch controller as soon
as redirect/range headers are available. The final CDN object is never fetched
by the server-side redirect resolver. Regression coverage proves the local
redirect target receives zero media requests.

Verification:

- isolated resolver: four sources in 1,337 ms, 82 MiB at return;
- held-open process: RSS stayed 79–82 MiB for fifteen seconds instead of
  exceeding 1.4 GiB;
- production resolver-only request: Next stayed 170–171 MiB and the repeat
  full resolve returned thirteen sources in 32 ms;
- all 497 tests then passed and TypeScript was clean;
- production image `sha256:f5b40e69baa2afa7d03ef1864947148dbdd4abdf69f6e45562a4c99af5f0b74f`
  deployed healthy with zero restarts and unchanged user data.

In-heap HLS segment caching remains disabled. Re-enable it only with a
stream-to-disk or otherwise bounded design and a playback memory stress test;
`Response.clone().arrayBuffer()` is not an acceptable production cache path.

### Progressive MP4 source-death recovery

The player gave every media engine one silent-stall recovery cycle. That was
valid for hls.js and dash.js, but direct progressive MP4 has no loader to
restart; its “recovery” was a 0.001-second seek. A dead RD source therefore sat
through two twelve-second no-progress windows before failover.

Commit `d2691e9` makes recovery capability explicit in the generation-scoped
`SourceAttemptController`. HLS/DASH retain one bounded recovery nudge; direct
progressive MP4 fails after one eight-second no-progress window. Late callbacks
remain generation-safe and terminal arbitration is still single-owner.

The identical Fight Club fault injection improved from 24,535 ms to 7,220 ms
recovery (70.6% faster). Playback resumed at the preserved mid-title position
on Luna, decoded at 1920x1080, and showed no waiting/stalled events. The
healthy RD seek remained 2,055 ms. All 498 tests passed.

### Scraper resource envelope and dead-provider removal

A sequential cold availability matrix exposed a concurrency load problem
after only three titles: five warm Chromium workers plus overlapping
background enrichments reached 1,304% CPU, 2.3 GiB, and 645 container PIDs.
The app stayed healthy, but that resident and burst cost was not justified for
thirteen users.

The production resource work was deliberately measured in stages:

- `f8eef23`: browser pool default 5 → 3, configurable and clamped;
- `ad4f534`: default 3 → 2 and health metrics stopped exposing signed media
  URLs (only host plus `hls`/`dash`/`mp4`/`media` path kind remains);
- `f8fef74`: default 2 → 1 and VidNest was removed from the primary browser
  wave after 0/8 production enrichments plus 0/3 isolated provider-only
  captures (Fight Club, Oppenheimer, The Office).

CinePro was also disabled through the production `.env` after 11/11 circuit
failures and a boot warmer pass that failed all twenty titles with HTTP 500.
Its URL remains configured for deliberate re-evaluation, but explicit
`PROVIDER_CINEPRO=0` prevents both request participation and the warmer.
The pre-change environment is recoverable at
`/home/hussy/cinehome-backups/20260726T114828Z-pre-f8eef23/.env`.

Measured effects:

- clean idle: about 405.6 MiB / 352 PIDs → 243.6 MiB / 130 PIDs;
- three-title cold peak: 2.3 GiB → 1.34 GiB;
- the same three-title slice remained 3/3 resolved and 3/3 with debrid;
- under the cold burst, forty live app requests averaged 5.58 ms, p95 8.48 ms,
  maximum 17.5 ms;
- signed query/path data no longer appears in `/health`;
- the pool is shared globally, reports live/idle/queued counts, and is bounded
  to one worker by default (operator range 1–4).

The current production image for this resource pass is
`sha256:f943fe70ed705baf4fed3d3f892d969989e53d1183c9ca8ec523f28dfa329415`.

### Debrid release quality and native-playability validation

Commits `c6e6bb6`, `e74f13e`, and `d84de5c` corrected three separate quality
failures instead of hiding them behind retries:

- cached candidates now rank with media-size and bitrate evidence instead of
  letting raw seeder counts dominate;
- native slots preserve rank after a rejected candidate instead of assigning
  round-robin positions before validation;
- unknown native containers must prove an ISO-BMFF `ftyp` signature, while
  M2TS, short clips, captures, featurettes, bonus/extras packs, soundtracks,
  deleted scenes, and broad IMDb collection packs fail closed.

The measured Oppenheimer M2TS object began with the MPEG-TS sync layout and
failed Chromium with `MEDIA_ERR_SRC_NOT_SUPPORTED`; it is no longer surfaced.
After the filters, Oppenheimer resolved only two validated native MP4 options
plus the honest Safari MKV option. Both native sources decoded at 1920x1080.
The authenticated eight-run production matrix remained 8/8 with the
top-ranked source playing 8/8; p50 was 8,487 ms and p95 was 11,017 ms. This
was an availability/quality win, not a general startup-speed claim: the
original baseline p50 was 5,664 ms and requires more work.

### Next runtime allocator containment

A full eight-playback run reproduced a second, independent retention problem
in the Next process:

- normal Bun sidecar: 117.6 MiB before, 870.1 MiB after twenty seconds;
- Bun `--smol`: 117.0 MiB before, 1,002 MiB after twenty seconds;
- forced Bun GC: live ArrayBuffers fell from about 1.64 GiB to 8.6 MiB, but
  process RSS remained 760.5 MiB.

The browser trace showed the trigger: multiple HLS providers intentionally
label 4–16 MiB media fragments as `image/jpeg`. CineHome already passed the
upstream `ReadableStream` through rather than calling `arrayBuffer()`, so the
retention was below the application cache in Bun's fetch/WebStream-to-Next
bridge. `--smol`, guard clauses, and cache tuning did not address it.

The standalone Next server was then isolated under Node while the scraper
remained on Bun:

- Node 20 diagnostic: 67.7 MiB before, 92.5 MiB after the matrix;
- supported Node 24.18.0 LTS candidate: 66.8 MiB before, 121.9 MiB after;
- Node 24 matrix: 8/8 playback, p50 8,776 ms, p95 14,608 ms, zero OOM;
- same warm Fight Club/Vidking source: Node 10,863 ms versus Bun 10,817 ms
  (46 ms difference);
- exact built image Fight Club smoke: 10,415 ms, top source played, no
  rebuffer/switch, 93.0 MiB RSS.

Decision: `start.sh` runs the Next standalone server on Node 24.18.0 LTS and
continues to run the scraper/build/tests on Bun 1.3.14. The official Node
archive is SHA-256 verified during the build. The image passed 517 tests,
1,147 expectations, TypeScript, full supervisor health, and real playback.

The same pass found `.browser-qa/` missing from `.dockerignore`; the build
context was 256.5 MiB and could include authenticated Playwright storage.
`.browser-qa/`, `transcode-cache/`, and `.runtime-cache/` are now excluded.
The verified context is 40.9 KiB, and image inspection proves
`/app/.browser-qa` is absent.
