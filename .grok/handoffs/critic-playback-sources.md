# Critic — playback source identity

**Repo:** `/Users/husnainali/cinehome`  
**Date:** 2026-08-14  
**Role:** harsh playback critic. No implementation.  
**Scope:** the six claimed remux / wrong-movie / trailer wires. Prior Hisense-engine / S0 leftovers are out of scope unless they still break these claims.

## VERDICT: PASS

All six claimed wires are live at the call sites that actually pick, resolve, remux, and auto-default. I did not find a dead helper, a remux-first-frame hole while a direct ≥1080 exists (`fast` / `auto`), or a remaining `pickLargestVideoFile` path on Real-Debrid.

Architect “COHERENT WITH NOTES” holds. The notes are real. They are fallbacks and conservatism, not an unwired product path.

I ran the lock tests. **225 pass / 0 fail.** I did not deploy. I did not watch a title.

---

## Claims

### 1. Cold start does not auto-upgrade to remux 4K when direct HD exists — PASS

The original hole was: `pickClientStartupSource` starts direct HD, then the roster effect treats remux 2160 as `betterHeight` and hops to Hades before first frame.

That hop is gated.

`pickClientStartupSource` (`src/lib/playback/client-ranking.ts`): `fast` / default starts `directHd` when any remux UHD also exists and exposes remux as `deferredFourK`. `maximum` still starts remux 4K. Remux-only rosters still start remux. Default `fourKStartup` is `"fast"`. `PLAYBACK_FAST_4K_ENABLED` is on unless `NEXT_PUBLIC_PLAYBACK_FAST_4K=0`.

Roster reconcile (`video-player.tsx:1885–1912`) uses that helper when the flag is on, else `pickDefaultSource` (claim 5). Before `setActiveSource(best)` it calls `shouldAdoptRosterUpgrade`. Remux over a selected/working **direct** source returns false unless `fourKStartup === "maximum"` or the user picked it. `userPicked` / `everPlayed` also refuse. First-frame race is closed earlier in the same effect: decoded `videoWidth > 0` → `markEverPlayed()` and return.

Luna CDN effect (`video-player.tsx:2426–2432`) has the same remux-over-direct lockout inlined. It is not the helper. Equivalent today. Do not fold it in without re-checking `pickIsNamedFast` — the helper also requires height/richer/faster/multi and would block Luna→Solstice.

Initial attach is `useState(null)`, not `orderedSources[0]`. Picker sort still ranks remux 4K first; that list is display, not attach. `streamUrl` is not what the engine plays.

After first frame, `fourKStartup === "fast"` prewarm **is** allowed to switch to remux 4K. `findLateFourKSource` returns null for remux. That is the intended Ultra handoff, not the cold-start steal.

### 2. Remux route uses the 10 min source URL cache before `resolveFullRoster` — PASS

`/api/transcode` (`route.ts:126–145`):

1. `lookupPlaybackSourceUrl({ userId, mediaType, tmdbId, season, episode, sourceId })`
2. miss only then `resolveFullRoster` + `rememberPlaybackRoster`

TTL is `SOURCE_URL_CACHE_TTL_MS = 10 * 60 * 1000`. Key is `userId:mediaType:tmdbId:season:episode:sourceId`. No RD token.

Writes:

| Site | When |
|---|---|
| `playback/[type]/[id]/route.ts:214` | cache HIT |
| `playback/[type]/[id]/route.ts:336` | cache MISS |
| `resolve-full.ts:65` | roster-cache HIT |
| `resolve-full.ts:88` | live merge |
| `transcode/route.ts:143` | remux miss fill |

Auth identity matches: playback `user.id` via `getAuthenticatedUser`; remux `getAuthenticatedUserId` → same helper. Movies omit season/episode on both sides → `user:movie:550:::sourceId`. Player `buildRemuxUrl` sends `sourceId` + `type` + `id` and TV `season`/`episode` when both are finite. Playback TV indexes with `tvQueryIndex` (0 stays 0; missing → 1). Watch always has S/E for TV remux.

Stored URL is the resolved debrid/embed URL (`source.url`), not `/api/transcode`. Remux ffmpeg gets the file, not a remux of a remux.

Fast playback writes whatever fast returned (native MP4 slots only — `isDirectPlayDebridRelease`). Remux 4K (Hades / `safari-2160`) is not on that fast roster. Full resolve writes the remux URL **before** the client can list/prewarm/pick it. Miss still falls back to `resolveFullRoster` (correct, just slow).

### 3. RD never `pickLargestVideoFile` on multi-video torrents — PASS

`pickLargestVideoFile` is gone. Grep: only comments / tests saying they do **not** do that. Stale module header in `realdebrid.ts:9` (“select the largest video file”) is a lie. Code does not.

Path (b) `resolveDebridDirectLink` → `pickDebridVideoFile` (`realdebrid.ts:269`):

- `fileIdx` match is `file.id === fileIdx + 1` (Torrentio 0-based, RD 1-based)
- miss → unique title-token match from `releaseTitle`
- multi-video + ambiguous / no tokens → `null` (skip candidate)
- single video file is OK

`releaseTitle` is threaded: `resolveDebridDirectLink(hash, candidate.fileIdx, candidate.title)` (`debrid/index.ts:456–459`).

Path (a) never called largest-file. It follows Torrentio’s resolve-proxy (`resolveTokenFreeRedirect`). File identity there is Torrentio’s. Movie-pack inventory drop (claim 4) is the common-path defense. A pack that slips the regex can still play the Torrentio-selected file. That is not `pickLargestVideoFile`.

### 4. Movie packs dropped from Torrentio — PASS

`parseTorrentioStreams` (`torrentio.ts:624–628`):

```
if (mediaType === "movie" && MOVIE_NON_FEATURE_PATTERN.test(text)) continue;
if (mediaType === "movie" && isMoviePackRelease(text)) continue;
```

Both live callers (`fetchTorrentioCandidates`, `fetchTorrentioCandidatesNoDebrid`) go through this parse. TV season packs stay. Extras/featurettes still drop. Integration test keeps `Movie.2024.1080p.WEB-DL` and drops MCU collection / complete series / season pack / filmography.

Regex: `season N` / `Sxx` / `complete series|season|pack` / `collection` / `filmography` / `duology` / `trilogy`. “Season of the Witch” is tested as kept. “The Collection” / boxset / anthology / “Complete Movies” can slip. Conservative, documented.

### 5. `pickDefaultSource` will not auto-default remux over direct HD — PASS

`pickDefaultSource` (`source-quality.ts:1265–1285`): if any `direct && height ≥ 1080` exists in the auto-play pool, remux rows sink. Height / probe / preference ranking runs after that.

`sortSourcesForPicker` / `compareDelivery` still ranks remux 4K above direct 1080 (keep pixels). Remux-only rosters still pick remux 4K over remux 1080. Tests lock both.

Player attach uses `pickClientStartupSource` (fast) or this pick. `use-playback` streamUrl uses this pick; watch prefers `sources[]` and only synthesizes from `streamUrl` when the list is empty. Fast debrid `buildFastDebridResponse` also uses this pick — and fast slots are MP4-native, so remux is not even in that list.

`tryNextSource` failover may land remux after direct HD is marked failed. That is failover, not auto-default.

### 6. Scraper trailer / sample cannot auto-default — PASS

Scraper `isNeverAutoDefaultUrl` is poison **plus** path/query/hash `trailer|preview|sample` (`SAMPLE-AES` stripped). `isNeverAutoDefaultSource` adds label tokens (`Official Trailer`).

Wired at the pick/rank sites, not just imported:

- `pickDefaultStreamUrl` / `sortSourcesForDefault` — clean over blocked; last resort if every row is blocked
- `scoreSourceEntry` / `providerPriority` — penalty / −10
- `isValidStreamUrl` — PW drop
- `capture-early-exit`, roster-health, quality-cap
- `buildMergedResult` — stamps `verified: false` on blocked embeds; drops duration-truncated URLs

`applyDurationExpectation` in `probe.ts` calls `isImplausibleEmbedDuration` (movie expected ≥80 min and observed ≤15 min, plus shared `assessMediaDuration`). Unknown durations fail open. Client `toPlaybackSource` forwards `verified: false`. Client `autoPlayPool` excludes `isSoftKept`.

Last resort: if every candidate is a trailer, one URL is still returned. Claimed. Same as poison.

Client `src/lib/playback/poison-url.ts` `isNeverAutoDefaultUrl` is **poison only**. Trailer defense on the player is the scraper stamp + soft-keep, not a second URL tokenizer. Residual, not a dead scraper wire.

---

## MUST-FIX

None.

---

## Residual (do not treat as fail)

1. **Path (a) skips file pick.** Torrentio resolve-proxy is the preferred RD path. Pack inventory drop is the defense. A pack title that slips the regex plays Torrentio’s file, not “largest.”
2. **Path (b) `links[0]` on an already-selected torrent.** `pickDebridVideoFile` then `selectFiles`, then `unrestrictLink(info.links[0])`. If RD already has the torrent with multiple files selected, `selectFiles` can no-op and `links[0]` need not be the picked file. Pre-existing. Rare next to path (a).
3. **Stale `CachedStream` rows.** Packs unrestricted before this change stay until TTL / `refresh=1`. File pick does not re-run on a warm slot.
4. **In-process URL cache.** Same pattern as roster cache. No `globalThis` singleton. Multi-instance / duplicated Next module misses and falls back to `resolveFullRoster`. Acceptable for this host.
5. **TV remux key.** If a caller omitted S/E, remux looks up `user:tv:id:::sourceId` against a write of `user:tv:id:1:1:sourceId` → miss → full roster. Player always sends S/E for TV. Movies unaffected.
6. **Luna lockout is duplicated.** Roster uses the helper; Luna inlines it. Equivalent. Do not “DRY” without re-checking named-fast hops.
7. **`isFasterSource` vs remux.** Comment + one test say remux is not a mid-play upgrade. Unprobed remux is false. A remux **with** a better probe score can still return true. Cold-start helper and Luna lockout still refuse remux-over-direct. Late-4K also refuses remux.
8. **Client trailer tokenizer is thinner than the scraper’s.** Player `isNeverAutoDefaultUrl` is poison-only. A trailer that arrives `verified: true` with a clean URL (stale scrape cache) can still auto-default on the client. Fresh scrape stamps `verified: false`.
9. **Conservative pack names.** `boxset` / `anthology` / `complete movies` / a title literally named “The Collection” are not all covered. “Season of the Witch” is kept on purpose.
10. **TorBox** has its own size-guard file pick. Out of this slice. Wrong-movie contract was RD `pickLargestVideoFile`.
11. **Prewarm after first frame** still remuxes 4K in `fast`. User sees HD first, then “4K ready — switching…”. That is not the cold-start Repackaging steal.
12. **`maximum` / remux-only / sub-HD-only** still start remux. Contract is “when direct HD exists.”
13. **`realdebrid.ts` header** still says “select the largest video file.” Comment drift.

---

## Tests I ran

```
bun test src/lib/playback/client-ranking.test.ts \
  src/lib/playback/source-quality.test.ts \
  src/lib/playback/debrid/torrentio.test.ts \
  src/lib/playback/debrid/rd-roster.test.ts \
  src/lib/playback/late-fourk.test.ts \
  src/lib/playback/source-url-cache.test.ts \
  src/lib/playback/debrid/pick-debrid-file.test.ts \
  mini-services/stream-scraper/poison-url.test.ts \
  mini-services/stream-scraper/default-source-rank.test.ts \
  mini-services/stream-scraper/embed-duration.test.ts
```

**225 pass / 0 fail.**

---

## Browser check (still the only honest proof)

```bash
cd /Users/husnainali/cinehome
bun scripts/browser/qa.ts flow watch-movie 550
```

Expect:

1. Auto first frame from a **direct HD** source. No “Repackaging…” before picture.
2. Remux 4K (Hades) still listed. Picking it remuxes. If playback just resolved, `/api/transcode` should not sit on a second full scrape.
3. Ultra + `fast`: HD first, optional “4K ready — switching…” after prewarm. Not a cold Hades steal.
4. A movie-pack Torrentio row should not appear / should not play a different title.

I did not deploy. I did not implement.
