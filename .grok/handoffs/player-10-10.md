# Player 10/10 — cinehome-player

Repo: `/Users/husnainali/cinehome` (not cinehome-sot).

## Behavior change

Hisense VIDAA / `data-tv=1` with no MSE HEVC now takes the **native HLS engine** even when every `canPlayType` string is empty. Inventory already trusted those panels (`supportsHevc`); the engine now matches, so remuxed Hades 4K HEVC is not handed to hls.js+MSE (black screen → 1080 failover).

Desktop unchanged: native path only when `!mseAccepts && elementAccepts`.

First-frame wall is remux-aware: remux or `/api/transcode` floors at **52s** (`FIRST_FRAME_WALL_REMUX_MS`), matching the packer budget. Cold non-remux stays 20s.

User tap on Hades remux 4K no longer swaps to Kronos 1080. `findDirectDebridAlternative` is **same-height only** (or both ≥2160). No sibling → remux pick stays and prewarms.

`mediaKey` is TMDB id, never display title. Untitled → real name no longer wipes resume + sticky source.

Unavailable delivery no longer builds `/api/transcode` (TRANSCODER_ENABLED=0 / 503). Remux path unchanged.

Zero-progress resume is actually longer than cold: **32s vs 22s**. Comments match.

`player_feedback` platform token is `vidaa` / `hisense` for those panels, not `chrome`.

Season/episode **0** (specials) is sent as 0, not coerced to S1E1.

4K remux prewarm now uses `prewarmRemuxPosition` (requires `#EXTM3U`), not bare HTTP 200. Late-4K finder already skips remux.

## Risk

- Native HLS on VIDAA forfeits the JS quality floor (already the trade-off). If the panel cannot play fMP4 HLS natively either, remux 4K still fails — but it no longer dies at 20s or hops to Kronos 1080 on a user pick.
- Resume zero-progress 32s is slightly more patient on a truly dead mid-title source.
- `mediaKey` without title: two titles with missing `tmdbId` and `tvId` would share `"movie:0::"` — only if both props are absent.

Resume playhead (`resumeAtRef`) still survives source switches. Poseidon/Kronos MP4-only native-slot remux ban untouched.

## Files

- `src/lib/playback/decode-capability.ts` — `hevcNeedsNativePath` TV+no-MSE
- `src/lib/playback/first-frame-wall.ts` — remux 52s floor
- `src/lib/playback/source-quality.ts` — same-height debrid sibling
- `src/lib/playback/device-profile.ts` — `uaPlatformToken` vidaa/hisense
- `src/lib/playback/scraper.ts` — season/episode 0
- `src/hooks/use-playback.ts` — `tvQueryIndex` (0 valid)
- `src/components/video-player.tsx` — mediaKey, remux wall, no transcode hop, no console, preferNativeHls, remux prewarm, remux URL season 0, resume 32s

Tests: `first-frame-wall`, `source-quality`, `codec-support-refresh`, `decode-capability`, `device-profile`, `use-playback-key`, plus `native-path`.

## Tests run

```
bun test src/lib/playback/first-frame-wall.test.ts \
  src/lib/playback/source-quality.test.ts \
  src/lib/playback/codec-support-refresh.test.ts \
  src/lib/playback/decode-capability.test.ts \
  src/lib/playback/device-profile.test.ts \
  src/hooks/use-playback-key.test.ts \
  src/lib/playback/native-path.test.ts
```

**132 pass / 0 fail.**

## Browser check

`bun scripts/browser/qa.ts flow watch-movie 550`

On the 85" Hisense: pick Hades remux 4K, confirm it stays Hades (not Kronos 1080) and first frame can take up to ~52s without failover. Open another movie — resume/source must not reset when the title hydrates.
