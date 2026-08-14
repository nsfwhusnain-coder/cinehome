# Critic — playback re-audit 2

**Repo:** `/Users/husnainali/cinehome`  
**Date:** 2026-08-14  
**Role:** harsh playback critic. No implementation.  
**Scope:** only the four claims from the 5/10 reject. Prior inventory / remux-wall / mediaKey / anime leftovers are out of scope unless they still break these claims.

## VERDICT: PASS

Player 4K/TV: **8 / 10**

The living-room engine is no longer inverted. Decision and attach agree. H.264 stays on hls.js. HEVC remux on a TV whose MSE has no HEVC assigns `video.src` even when mpegurl `canPlayType` is `""`. Native death is `failActiveSource`, not `"Your browser can't play HLS streams."`. Torrentio specials request `:0:1.json` and a test locks it.

That was the cliff. It is gone. 8, not 10: native fMP4 HLS on VIDAA Chromium is still unproven on the 85", and the attach branch itself is still not a player-level test. Those are residuals, not MUST-FIX. The previous reject’s two play-path defects are fixed.

---

## Claims

### 1. H.264 TV uses hls.js — PASS

`preferNativeHls` is source-scoped. It is no longer `hevcNeedsNativePath()` on every TV row.

```164:181:src/components/video-player.tsx
function preferNativeHls(
  _video: HTMLVideoElement,
  source?: PlaybackSource | null
): boolean {
  if (!isTvLikeDevice()) return false;
  return shouldUseNativeHlsOnTv({
    isTv: true,
    hevcNeedsNative: hevcNeedsNativePath(),
    codec: source?.codec,
    origin: source?.origin,
    compat: source?.compat,
    delivery: source ? sourceDelivery(source) : undefined,
  });
}
```

`shouldUseNativeHlsOnTv` (`src/lib/playback/hls-engine.ts`) is `isTv && hevcNeedsNative && sourceLooksLikeHevc`.

`sourceLooksLikeHevc` is false for:

- `codec === "h264"` (explicit remux included)
- `codec === "av1"`
- unknown embed HLS (Luna / Quasar / Vixsrc: `origin === "embed"`, delivery not remux)

VIDAA: `Hls.isSupported() === true`. Attach:

```
if (Hls.isSupported() && !preferNative) → hls.js
```

H.264 / Luna / unknown embed on that panel: `preferNative === false` → hls.js. The old “skip the only Chromium HLS engine, then die” path is gone for these rows.

Tests lock the gate (`native-path.test.ts`: H.264, H.264 remux, unknown embed → false).

### 2. HEVC remux TV tries native even if mpegurl probe empty — PASS

The previous reject was decision vs attach: native was chosen, then attach still required `canPlayType("application/vnd.apple.mpegurl")`, which VIDAA leaves `""`.

Attach now (`video-player.tsx:3075–3076`, `3606–3616`):

```
const preferNative = preferNativeHls(video, activeSourceRef.current);
if (Hls.isSupported() && !preferNative) { hls.js }
else if (preferNative || Boolean(video.canPlayType("application/vnd.apple.mpegurl"))) {
  video.src = effectiveSrc;   // mpegurl may be ""
}
else { setError("can't play HLS") }
```

`preferNative` true is enough. The mpegurl probe is no longer a gate on the native remux path.

`sourceLooksLikeHevc` is true for:

- `codec === "hevc"`
- unknown + `origin === "debrid"` + `compat === "safari"` (Hades tagging)
- unknown + `delivery === "remux"` (untagged remux; explicit `h264` remux excluded above)

Hades rows from `cachedToPlaybackSource` are `origin: "debrid"`, `compat: "safari"` when HEVC, `container` usually `mkv` so `sourceDelivery` is `"remux"`, and remux URLs are `/api/transcode` → `useHls` is true. All three HEVC signals can fire; any one is enough.

`hevcNeedsNativePath()` is still true on Hisense when MSE rejects every `hvc1` string (`codec-support-refresh.test.ts`). Desktop stays off this gate (`isTvLikeDevice()` false, and `shouldUseNativeHlsOnTv` requires `isTv`).

### 3. Native fail → failActiveSource, not a global HLS error — PASS

`"Your browser can't play HLS streams."` is only the last `else` of the HLS attach. HEVC remux TV never reaches it (`preferNative` is true).

On the native branch, `video.src` is assigned. The media `error` listener is bound earlier in the same effect, before the engine switch (`video-player.tsx:2829–2837`):

```
failActiveSource("media_element_error", sourceAttempt);
```

`failActiveSource` marks the row failed and hops (`tryNextSource`). Exhaustion surfaces `ALL_SOURCES_FAILED_MSG`, not the HLS-capability string. Kronos / Luna remain eligible.

If Chromium swallows the assign and sits black (no `error` event): remux `/api/transcode` also arms the 52s zero-progress watchdog (`isTranscoded`) and the remux first-frame wall. Both call `failActiveSource` (`first_frame_timeout` / `zero_progress`). The wall no-ops only when `error` is already set; this path does not set `error` on attach.

### 4. Torrentio S0 path is `:0:1` and tested — PASS

`buildKindPath` uses `tvQueryIndex` (0 stays 0; missing / NaN / negative → 1):

```568:578:src/lib/playback/debrid/torrentio.ts
export function buildKindPath(params: { ... }): string {
  const season = tvQueryIndex(params.season);
  const episode = tvQueryIndex(params.episode);
  return params.mediaType === "tv"
    ? `stream/series/${params.imdbId}:${season}:${episode}.json`
    : `stream/movie/${params.imdbId}.json`;
}
```

Both live callers (`fetchTorrentioCandidates`, `fetchTorrentioCandidatesNoDebrid`) go through this path. Debrid cache key keeps `req.season ?? 0` (`debrid/index.ts:961`, `1121`) and passes that 0 into Torrentio. Playback route already uses `tvQueryIndex`. The old `season && season > 0 ? season : 1` is gone from this file.

Test (`torrentio.test.ts`):

- `season: 0, episode: 1` → contains `:0:1.json`, does not contain `:1:1.json`
- missing season/episode → `:1:1.json`
- movie + season 0 → no series segment

Ran: **80 pass / 0 fail** across `torrentio.test.ts`, `native-path.test.ts`, `decode-capability.test.ts`, `codec-support-refresh.test.ts`, `tv-index.test.ts`.

---

## MUST-FIX

None.

---

## Score

| Slice | Was | Now | Why |
|---|---|---|---|
| Engine (what actually decodes) | 3 | 8 | Decision and attach agree; H.264 no longer sacrificed; HEVC remux attaches without mpegurl. Native fMP4 on VIDAA still unproven on-device. |
| Season 0 (debrid play path) | 4 | 8 | Torrentio path is `:0:1` and tested. Upstream Torrentio may still 404 specials; client no longer lies. |
| Tests as contract (these claims) | 4 | 6 | Gate + `buildKindPath` locked. Attach order still lives only in `video-player.tsx`. |
| **Player 4K/TV** | **5** | **8** | Cliff gone. 4K on the 85" is now “try native remux, failover if the SoC refuses,” not “hard-error every HLS title.” |

Not 9: I did not watch the 85". Native HLS on Chromium VIDAA can still fail over after 52s. That is the documented residual, not a code revert of the four claims.

---

## Residual (do not treat as fail)

- Native fMP4 HLS on VIDAA Chromium is still unproven. If the SoC will not play remux as `video.src`, Hades failovers (52s wall / element error). H.264 embeds no longer die on attach. That is the intended trade.
- `shouldUseNativeHlsOnTv` is tested; `preferNativeHls` + the `preferNative \|\| mpegurl` attach branch are not. A one-line attach revert is still invisible to CI. Residual contract hole, not a live defect.
- If MSE ever answers true on a bare `hvc1` string, `hevcNeedsNativePath` is false and remux stays on hls.js. Hisense tests say MSE rejects every probe. Unchanged residual.
- Untagged remux (`codec` unknown + `delivery === "remux"`) is treated as HEVC on TV. Explicit `h264` remux stays on hls.js. Intentional.
- Stale RD cache minted under the old S0→S1 rewrite can still hold S1 bytes until expiry / `refresh=1`. Code path is correct for new resolves.
- Torrentio-the-service may ignore or 404 `:0:`. The client no longer rewrites the request to S1.

---

## Browser check (still the only honest 85" proof)

```bash
cd /Users/husnainali/cinehome
bun scripts/browser/qa.ts flow watch-movie 550
```

On the 85" Hisense:

1. Vixsrc / Luna H.264 must play (hls.js). Must not show “can't play HLS”.
2. Pick Hades remux 4K — stays Hades; first frame may take ~52s. Decode fail → Kronos/Luna, not a global HLS error.
3. Deep-link `/watch/tv/{id}?season=0&episode=1` with RD — playing file must not be S1E1.

I did not deploy. I did not implement.
