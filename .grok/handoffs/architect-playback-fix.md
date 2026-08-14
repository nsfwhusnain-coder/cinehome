# Architect — playback-fix cohesion

**Repo:** `/Users/husnainali/cinehome` (not cinehome-sot)
**Date:** 2026-08-14
**Role:** glue only. No redesign. No transcoder enable. Poseidon/Kronos stay MP4-only.

## Verdict: COHERENT WITH NOTES

All six player MUST-FIX wires are live at the call sites the contract named. I did not change code. Residuals are real but they are fallbacks, comment drift, or duplicate lockouts — not an unwired product path.

Scraper slice is independently wired (`isImplausibleEmbedDuration` in `probe.ts`; trailer/sample is a never-auto-default superset). It does not need a player stitch.

---

## MUST-FIX wire table

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Cache written on playback route | **LIVE** | `rememberPlaybackRoster(sourceCacheIdentity, …)` on HIT (`route.ts:214`) and MISS (`route.ts:336`). Identity is `userId + mediaType + tmdbId + season + episode`. RD token is not in the key. `resolve-full.ts` writes on roster-cache HIT and after a live merge. |
| 2 | Remux reads the cache | **LIVE** | `/api/transcode` `lookupPlaybackSourceUrl` first (`route.ts:128–134`). Miss only then `resolveFullRoster` + `rememberPlaybackRoster`. Same `user.id` via `getAuthenticatedUserId` → `getAuthenticatedUser`. Movie remux URL is `type+id+sourceId` with no season — keys match `user:movie:550:::sourceId`. |
| 3 | File pick used | **LIVE** | `resolveDebridDirectLink` → `pickDebridVideoFile` (`realdebrid.ts:269`). `fileIdx` is `file.id === fileIdx + 1`. Miss → unique title-token match. Multi-video + ambiguous → `null`. Never largest-file. Title threaded: `resolveDebridDirectLink(hash, candidate.fileIdx, candidate.title)` (`debrid/index.ts:456–459`). |
| 4 | Pack filter on movies only | **LIVE** | `parseTorrentioStreams`: `mediaType === "movie" && isMoviePackRelease(text)` (`torrentio.ts:627–628`). Shared by RD and no-debrid TorBox fetches. TV season packs stay. Integration test drops MCU collection / complete series / season pack / filmography and keeps `Movie.2024.1080p.WEB-DL`. |
| 5 | Default pick does not remux over direct HD | **LIVE** | `pickDefaultSource` sinks remux when any `direct && height ≥ 1080` exists (`source-quality.ts:1265–1285`). Picker (`sortSourcesForPicker`) still ranks remux 4K above direct 1080. Remux-only rosters still pick remux 4K over remux 1080. `pickClientStartupSource` starts direct HD in `fast` and exposes remux as `deferredFourK`. `maximum` may start remux 4K. |
| 6 | Roster upgrade helper used in video-player | **LIVE** | Import + cold-start gate (`video-player.tsx:1904–1912`). Luna effect has the **same remux-over-direct lockout inlined** (`2426–2432`), not the helper. Equivalent today. `findLateFourKSource` returns null for remux. Prewarm is the only auto remux 4K after first frame (`fourKStartup === "fast"`). |

---

## What I checked that is not a dead wire

- `pickLargestVideoFile` is gone. Only leftover is a **stale module header** in `realdebrid.ts:9` (“select the largest video file”). Code does not do that.
- Playback `streamUrl` is `pickDefaultSource` (HD when direct HD exists). Player attach is the source list + `pickClientStartupSource`, not `streamUrl`.
- Remux URL builder sends `sourceId` / `type` / `id` / TV `season`+`episode`. Transcode looks up that identity. Auth ids match.
- `healthAware` only adds `runtimeHealth`. URLs written to the source-url cache are the resolved ones.
- Fast playback writes whatever fast returned. Remux 4K is not on the MP4-only fast slots. Full resolve writes the remux URL **before** the client can prewarm/pick it.
- `TRANSCODER_ENABLED` untouched. Remux stays `REMUX_ENABLED !== "0"`.
- Scraper: `applyDurationExpectation` calls `isImplausibleEmbedDuration`. Rank/score/valid-url/roster-health/quality-cap use never-auto-default. `buildMergedResult` stamps `verified: false` on blocked embeds.

No stitch was required. I did not edit source.

---

## Notes (not MUST-FIX)

1. **Path (a) skips file pick.** Torrentio resolve-proxy URLs still unrestrict via `resolveTokenFreeRedirect`. `pickDebridVideoFile` is path (b) only (no URL, or redirect fail). Movie-pack inventory drop is the common-path wrong-movie defense. A pack title that slips the regex can still play the Torrentio-selected file.

2. **Luna lockout is duplicated.** Roster effect uses `shouldAdoptRosterUpgrade`. Luna uses an inline `sourceDelivery(pick) === "remux" && current === "direct" && fourKStartup !== "maximum"`. Do not fold Luna into the helper without re-checking `pickIsNamedFast` — the helper also requires height/richer/faster/multi and would block some Luna→Solstice hops.

3. **In-process cache.** Same pattern as roster cache. Multi-instance / a duplicated Next server module would miss and fall back to `resolveFullRoster` (correct, just slow). No `globalThis` singleton. Acceptable for this host.

4. **Stale RD cache rows.** Packs unrestricted before this change stay in `CachedStream` until TTL/invalidation. File pick does not re-run on a warm slot.

5. **`isFasterSource` vs remux.** Comment + test say remux is not a mid-play upgrade. Unprobed remux is false. A remux **with** a better probe score can still return true. Cold-start helper and Luna lockout still refuse remux-over-direct. Late-4K also refuses remux.

6. **TV remux key.** Playback stores `tvQueryIndex` (0 stays 0; missing → 1). Transcode uses the remux query as-is. Player always sends S/E for TV remux. If a caller omitted them, cache miss → full roster. Movies unaffected.

7. **Conservative pack names.** `collection` / `trilogy` / `filmography` / `duology` / `complete series|season|pack` / `Sxx` drop movie inventory. “Season of the Witch” is tested as kept. A title literally named “The Collection” can hide.

8. **TorBox** still has its own size-guard file pick. Out of this slice. Wrong-movie contract was RD `pickLargestVideoFile`.

---

## Explicit non-scope (unchanged)

- Do not set `TRANSCODER_ENABLED=1`
- Do not put MKV on Poseidon/Kronos native slots
- Do not auto-start remux 4K when a direct ≥1080 exists (`fast` / `auto`)
- Do not publish scraper `:3030`
- No Godot / EventBus / new autoloads

---

## Tests I did not run

Parent should run:

```bash
cd /Users/husnainali/cinehome

bun test src/lib/playback/client-ranking.test.ts \
  src/lib/playback/source-quality.test.ts \
  src/lib/playback/debrid/torrentio.test.ts \
  src/lib/playback/debrid/rd-roster.test.ts \
  src/lib/playback/late-fourk.test.ts \
  src/lib/playback/source-url-cache.test.ts \
  src/lib/playback/debrid/pick-debrid-file.test.ts

bun test mini-services/stream-scraper
```

Browser (after deploy): `bun scripts/browser/qa.ts flow watch-movie 550`  
Expect: first frame from a direct HD source (no “Repackaging…” on auto). Remux 4K still listed.
