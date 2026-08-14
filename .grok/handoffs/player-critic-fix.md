# Player critic MUST-FIX — cinehome-player

Repo: `/Users/husnainali/cinehome` (not cinehome-sot).

## Behavior change

### 1. Hisense attach is no longer inverted

`preferNativeHls(video)` used to return `hevcNeedsNativePath()` on **every** TV row. VIDAA has `Hls.isSupported() === true` and empty mpegurl `canPlayType`, so attach skipped hls.js and then hard-errored `"Your browser can't play HLS streams."` — Luna H.264 included.

Now `preferNativeHls(video, source)` is source-scoped via `shouldUseNativeHlsOnTv`:

| Device | Source | Engine |
|---|---|---|
| TV + MSE no HEVC | H.264 / Luna / Quasar / unknown embed | **hls.js** |
| TV + MSE no HEVC | HEVC remux (Hades), or unknown debrid `compat:safari` | **native `video.src`** even if mpegurl is `""` |
| TV + MSE has HEVC | any | hls.js |
| Desktop | any | unchanged (hls.js, or Safari mpegurl native) |

Attach order:

1. `preferNativeHls(video, source)` → native `video.src`
2. else `Hls.isSupported()` → hls.js
3. else mpegurl `canPlayType` → native
4. else `"can't play HLS"`

Native remux `error` / decode fail already hits `failActiveSource("media_element_error")` (bound before attach). Kronos/Luna failover. No global HLS error on that path.

### 2. Torrentio season 0

`buildKindPath` used `season && season > 0 ? season : 1`, so Specials (`season=0`) requested `:1:1.json`. Now uses `tvQueryIndex` (0 stays 0; missing/NaN/negative → 1). Exported for tests.

## Risk

- Native fMP4 HLS on VIDAA Chromium is still unproven. If the SoC will not play remux HLS as `video.src`, Hades 4K **failovers** (first-frame wall 52s / element error) instead of a hard HLS error. H.264 embeds no longer die on attach.
- Untagged remux (`codec` unknown + `delivery === "remux"`) is treated as HEVC on TV. Explicit `h264` remux stays on hls.js.
- Poseidon/Kronos MP4-only (`isDirectPlayDebridRelease`) not touched.
- `resumeAtRef` still survives source switches.

## Files

- `src/lib/playback/hls-engine.ts` — `shouldUseNativeHlsOnTv` / `sourceLooksLikeHevc`
- `src/components/video-player.tsx` — source-scoped `preferNativeHls` + attach gate
- `src/lib/playback/debrid/torrentio.ts` — `buildKindPath` + `tvQueryIndex`
- `src/lib/playback/native-path.test.ts` — engine-gate tests
- `src/lib/playback/debrid/torrentio.test.ts` — `:0:1.json`

## Tests run

```
bun test src/lib/playback/debrid/torrentio.test.ts \
  src/lib/playback/native-path.test.ts \
  src/lib/playback/decode-capability.test.ts \
  src/lib/playback/codec-support-refresh.test.ts
```

**79 pass / 0 fail.**

## Browser check

```
bun scripts/browser/qa.ts flow watch-movie 550
```

On the 85" Hisense:

1. Vixsrc / Luna H.264 must play (hls.js). Must not show "can't play HLS".
2. Pick Hades remux 4K — stays Hades; first frame may take ~52s. Decode fail → Kronos/Luna, not a global HLS error.
3. Deep-link `/watch/tv/{id}?season=0&episode=1` with RD — playing file must not be S1E1.
