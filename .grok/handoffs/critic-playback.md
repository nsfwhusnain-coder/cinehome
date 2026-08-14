# Critic — playback 10/10

**Repo:** `/Users/husnainali/cinehome`  
**Date:** 2026-08-14  
**Role:** harsh playback critic. No implementation.

## VERDICT: FAIL

Player 4K/TV: **5 / 10** (not satisfied below 8)

The helper slice is real. Inventory, remux wall, same-height debrid tap, `mediaKey`, and the embed/API season-0 stitch are no longer the bugs they were. The **living-room engine path is still not a 4K player**. Hisense VIDAA is Chromium. The “native HLS” fix walks off MSE and then requires a `canPlayType('application/vnd.apple.mpegurl')` the same file says VIDAA often leaves empty. That is not 4K on the 85". That is a new failure mode. Debrid still resolves S0 as S1. Tests lock the helpers and leave the call sites that actually play.

Player 10/10 and architect “COHERENT WITH NOTES” over-claim. Helpers passing is not Hisense 4K playing.

---

## MUST-FIX

### 1. Hisense 4K remux still cannot attach (engine path is a cliff)

Not “maybe MSE.” The decision function and the attach branch do not agree, and neither path plays HEVC remux on VIDAA Chromium.

`preferNativeHls` (video-player.tsx:163–176):

- TV only (`isTvLikeDevice()`).
- Then `return hevcNeedsNativePath()`.
- **Not source-scoped.** Every HLS row on a trusted TV (Vixsrc 1080, remux 4K, the lot) forfeits hls.js.

`hevcNeedsNativePath` (decode-capability.ts:262–266) is correct as a *helper*:

- MSE HEVC → false (keep MSE).
- element HEVC → true.
- else living-room trust (UA / `data-tv=1`) → true, even when every `canPlayType` is `""`.

Attach (video-player.tsx:3069–3070, 3600–3678):

```
if (Hls.isSupported() && !preferNativeHls(video)) { hls.js }
else if (video.canPlayType("application/vnd.apple.mpegurl")) { native_hls; video.src = … }
else { setError("Your browser can't play HLS streams.") }
```

VIDAA UA in tests is Chrome/76. `Hls.isSupported()` is true (MSE+AVC). Native HLS is a WebKit feature. `canPlayType(mpegurl)` on stock Chromium is `""`.

So on the 85":

1. `preferNativeHls` is true → **skip the only HLS engine Chromium has**.
2. mpegurl probe is empty → **do not set `video.src`**.
3. Hard error, not failover (`setError`). First-frame wall then no-ops because `error` is set (video-player.tsx:2691).

The comment *on the same function* already admits this: “Hisense VIDAA answers `""` for every hvc1 string **AND often mpegurl** — do not require the mpegurl probe once `hevcNeedsNativePath` already selected native.” They removed the probe from the *decision* and left it on the *attach*. Half a fix.

Worse: this is not HEVC-only. A living-room panel that was playing H.264 embeds through hls.js now takes the same cliff. That can black out **all** HLS on Hisense, not just Hades 4K.

If MSE ever lies true on a bare `hvc1` string (the probe matrix includes it — decode-capability.ts:49–50), `hevcNeedsNativePath` returns false and remux 4K **does** go hls.js+MSE and blacks out. That is the original bug, still reachable.

Native fMP4 HLS on VIDAA is unproven even if someone force-assigns `video.src`. Chromium will not magically grow AVFoundation. 4K HEVC on this panel needs progressive HEVC MP4 the SoC will decode, or an H.264 4K sibling, or a real transcode (disabled). “Use native HLS” is the wrong engine for this UA.

**Tests do not lock this.** `codec-support-refresh.test.ts` locks the helper. `native-path.test.ts` still documents the *old* rule (“only true when element HEVC && !MSE”) and never instantiates the player. Nothing asserts: TV + no MSE HEVC + empty mpegurl ⇒ still attaches *something* that can play. A one-line revert of `preferNativeHls` or the mpegurl `else if` is invisible to CI.

### 2. Season 0 still plays the wrong episode on debrid

Embed / API / watch / preresolve / remux query / scraper client: **0 stays 0.** I checked.

Torrentio, the path that actually fills Hades/Poseidon/Kronos, still does this (debrid/torrentio.ts:567–572):

```ts
const season = params.season && params.season > 0 ? params.season : 1;
const episode = params.episode && params.episode > 0 ? params.episode : 1;
```

`resolveDebridSources` keeps `req.season ?? 0` in the cache key (debrid/index.ts:1121–1123) and passes that 0 into `fetchTorrentioCandidates` (index.ts:800–806). Torrentio rewrites the HTTP path to `stream/series/<imdb>:1:1.json`. RD/TorBox links for **S1E1** are minted, labeled, and cached as **S0**.

Playback route merges that roster (route.ts:243–301) and will even short-circuit a fast debrid-only response. Debrid ranks above embeds. Deep-link `/watch/tv/{id}?season=0&episode=1` can **auto-play season 1**.

Architect already wrote this down as leftover. Leftover on a live play path is MUST-FIX, not a note. `tv-index.test.ts` / `use-playback-key.test.ts` never fetch Torrentio. Zero tests mention `buildKindPath` or `stream/series/...:0:`.

Episode 0 is the same coerce. Rare, same class of bug.

### 3. Tests do not lock the claims that matter

Ran (152 pass / 0 fail) — passing tests around a hole are not a lock.

| Claim | Helper test | Play-path lock |
|---|---|---|
| Hisense does not sit on MSE / actually attaches | `hevcNeedsNativePath` yes | **No.** Attach still requires mpegurl. |
| Remux wall 52s | `first-frame-wall.test.ts` yes | No test that video-player passes `remuxOrTranscode` or that `/api/transcode?mode=remux` takes `TRANSCODE_ZERO_PROGRESS_FAIL_MS`. Constants are copy-pasted (52_000 in two files). |
| 4K tap ≠ 1080 | `findDirectDebridAlternative` yes | Call site is one line. Acceptable. |
| `mediaKey` is not `title` | **None** | Identity string is inline in video-player.tsx:1699. Adding `title` back is a silent resume wipe. |
| Anime classifier | `tmdb-anime.test.ts` yes | No `content-class` test (fail-open, keywords nest, cache key). |
| Season 0 | `tvQueryIndex` yes | **Torrentio untested.** The broken line is the untested one. |
| Remux prewarm `#EXTM3U` | retries/404/abort only | No test that HTTP 200 HTML is a miss. |

`native-path.test.ts` header is now **false** (see Residual). I did not edit it.

---

## Checked — not MUST-FIX

### Remux first-frame wall is not 20s

`FIRST_FRAME_WALL_REMUX_MS = 52_000`. `firstFrameWallMs({ remuxOrTranscode: true })` floors at 52s. Tests lock both remux-on and remux-off.

Player arms it (video-player.tsx:2685–2688) when `sourceDelivery(activeSource)==="remux"` **or** `effectiveSrc` contains `/api/transcode`. Remux URLs are `/api/transcode?mode=remux` (buildRemuxUrl:479). Zero-progress on that URL uses `TRANSCODE_ZERO_PROGRESS_FAIL_MS = 52_000` (isTranscoded + native remux watchdog). Cold non-remux stays 20s/22s. Resume zero-progress is actually 32s vs 22s. Comments match.

Residual: wall effect deps omit `remuxOrTranscode` / `effectiveSrc` (id-only). Fine today because remux is a property of the source object from first paint of that id.

### 4K tap no longer swaps to Kronos 1080 in the picker helper

`findDirectDebridAlternative` is same-height, or both ≥2160. Unknown height (0) does not match 1080. User pick uses that helper and sets `userSelectedSourceRef` so reconcile will not hop. Late-4K finder already refuses remux (`late-fourk.ts:57`, tested). Auto rank still prefers remux 4K over direct 1080 (compareDelivery).

If Hisense attach (#1) errors, the user is stuck on the 4K row or must pick 1080 by hand. That is #1, not a sibling-swap regression.

### `mediaKey` does not use title (code only)

```ts
`${mediaType ?? "movie"}:${tmdbId ?? tvId ?? "0"}:${tvSeason ?? ""}:${tvEpisode ?? ""}`
```

Watch passes `tmdbId={id}` from the route on first paint (`id` is `Number(id)`). `0 ?? ""` keeps season 0. Untitled → real name cannot reset the session. **No test.** That is MUST-FIX #3, not a code defect.

### Anime classify matches the written spec

`isTmdbAnimeTitle`: Animation (id 16 or genre name) **and** (`ja`/`jpn` **or** origin/production `JP` **or** genre/keyword contains `anime`). Western US animation is false. JP live-action without Animation is false. Tests lock those three plus keyword-`anime` and `production_countries: JP`.

`resolvePlaybackContentClass` fail-opens. Route classifies before cache. Scraper client sends `contentClass=anime`. Cache keys take the class. No MAL.

Residual, not MUST-FIX:

- `keyword.includes("anime")` matches `anime-influenced`. A US cartoon with that keyword becomes anime.
- `production_countries: JP` is treated as origin. Outsourced US animation can trip it. The test **locks** that behavior.
- Japanese titles missing genre 16 stay default. Fail-open.

Not “Western animation tagged anime” or “JP live-action tagged” under the spec they wrote.

### Season 0 on the embed play path is fixed

| Site | 0 stays 0? |
|---|---|
| `tvQueryIndex` | yes (`>= 0`) |
| playback API | yes |
| `use-playback` query | yes |
| watch URL + progress | yes (`??` not `\|\|`) |
| preresolve | yes |
| scraper client | yes (`!= null && finite`) |
| remux query | yes (`!= null && finite`) |
| Torrentio `buildKindPath` | **NO — MUST-FIX #2** |

Watch still hides S0 in the picker (`season_number > 0`). Deep link works for embeds. Architect noted that. Not a play-path coerce.

### Other player 10/10 claims that hold

- Unavailable delivery does not invent `/api/transcode` without remux (`serverPath = needsRemux`).
- `uaPlatformToken`: vidaa / hisense before chrome. Tested.
- `supportsHevc()` trusts TV / `data-tv=1`. Tested.
- `resumeAtRef` still captured on source change.
- Poseidon/Kronos remux ban not touched.
- No `console.log` in video-player.

---

## Residual (do not treat as pass)

- **`native-path.test.ts` comment is wrong.** It still says native is only `!mse && elementAccepts`. Implementation has a third living-room branch. Desktop cases in that file are still valid. Did not edit.
- Health registry `contentClass` on the playback route is still `movie \| tv`, not `anime`. Ranking wire is separate.
- Remux 52s is duplicated (`FIRST_FRAME_WALL_REMUX_MS` vs `TRANSCODE_ZERO_PROGRESS_FAIL_MS`) instead of one named import.
- S0 has no in-app Specials row. Fine if debrid stops lying.
- Playback API `console.info` JSON (fast debrid / coordinator shadow) is not the player, but it is still a production log.

---

## Score

| Slice | /10 | Why |
|---|---|---|
| Inventory (HEVC trust, 4K shown) | 8 | Helper + tests. |
| Engine (what actually decodes) | 3 | Native HLS on Chromium VIDAA is a fantasy; mpegurl gate still there; not HEVC-scoped. |
| Remux patience | 8 | 52s wall + 52s zero-progress on `/api/transcode`. Unshared constants. |
| 4K user tap | 8 | Same-height helper + sticky pick. Hisense still can’t hold the remux. |
| Identity / resume | 7 | Code right, untested. |
| Season 0 | 4 | Embeds good; debrid plays S1. |
| Anime lane | 7 | Spec-correct; substring / production_countries residue. |
| Tests as contract | 4 | Helpers green; Hisense attach, mediaKey, Torrentio S0 unlocked. |

**Player 4K/TV: 5/10.** Helpers without an engine are a slide deck.

---

## What “done” would require (for the next agent — do not do it here)

1. On Hisense / `data-tv=1` / no MSE HEVC: do **not** skip hls.js unless native mpegurl actually answers, **or** attach remux as progressive fMP4/`<video src>` without an mpegurl gate. Do not apply native-path to H.264 embeds. Add a test that empty mpegurl does not `setError` the only playable engine.
2. `buildKindPath` must use `tvQueryIndex` (0 stays 0). Test `stream/series/<imdb>:0:1.json`. Do not cache S1 bytes under an S0 key.
3. Contract tests: mediaKey has no `title`; remux wall uses remux delivery; prewarm 200 without `#EXTM3U` fails.

---

## Browser check (still required after the MUST-FIX, not instead of it)

```bash
cd /Users/husnainali/cinehome
bun scripts/browser/qa.ts flow watch-movie 550
```

On the 85" Hisense, this is the only honest check:

1. Confirm the engine: if DevTools exist, `playbackEngineRef` / network must not be “error + no src” on a remux row.
2. Pick Hades remux 4K. It must stay Hades. First frame may take ~52s. It must not die at 20s and must not become Kronos 1080.
3. A normal H.264 embed (Vixsrc) must still play. If this change shipped as-is, that is the first thing I would expect to break.
4. Open another title: resume/source must survive title hydration.
5. Deep-link a real Specials row (`/watch/tv/{id}?season=0&episode=1`) with RD configured. The playing file must not be S1E1.

I did not deploy. I did not implement. I did not “fix” the stale `native-path.test.ts` comment.
