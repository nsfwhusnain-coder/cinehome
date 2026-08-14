# Player playback fix — remux start + wrong movie

Repo: `/Users/husnainali/cinehome` (not cinehome-sot). Contract: `.grok/handoffs/playback-fix-contract.md`.

## Behavior change

Cold start no longer auto-jumps from a working **direct HD** source into a remux 4K (Hades “Repackaging…”) unless the profile is `fourKStartup === "maximum"` or the user picked it.

- `pickClientStartupSource` still starts direct HD in fast/auto and exposes remux 4K as `deferredFourK` for the existing post-first-frame prewarm.
- `shouldAdoptRosterUpgrade` blocks `betterHeight` / richer / faster from promoting remux over a selected/working **direct** source before `everPlayed`.
- The Luna CDN auto-upgrade effect has the same remux-over-direct lockout.

`pickDefaultSource` matches that product rule: if any **direct ≥1080** exists, remux cannot win the auto-default. Remux 4K still ranks above 1080 in `sortSourcesForPicker` and still wins when every source remuxes. Remux 4K still beats remux 1080.

Remux `/api/transcode` looks up a **10-minute source URL cache** (`userId + media + sourceId`) written on every successful playback / full-roster resolve. Cache hit skips `resolveFullRoster` (no second scrape + debrid just to start ffmpeg). Miss still resolves and fills the cache. RD tokens are not in the key.

Wrong-movie pack unrestrict is gone:

- `pickDebridVideoFile`: fileIdx match, else unique filename-token match from the Torrentio title. Multi-video + ambiguous → **null** (skip candidate). Never largest-file. Single video file is OK.
- Movie Torrentio inventory drops season packs / complete series / collection / filmography / duology / trilogy. Extras/featurettes still dropped. A normal `Movie.2024.1080p.WEB-DL` stays.

Poseidon/Kronos MP4-only native slots untouched. `TRANSCODER_ENABLED` untouched. `resumeAtRef` still survives source switches. Media identity still resets on title/season/episode.

## Risk

- A movie whose only 4K is remux will start HD and switch after prewarm (fast) or only if the user picks 4K / Maximum. First frame is faster; 4K is later.
- Conservative pack drop can hide a title literally named “The Collection” / “Trilogy”.
- Conservative file pick skips a multi-video torrent when the title cannot uniquely name a file — better than playing the wrong feature.
- Source URL cache is in-process (same as roster cache). Multi-instance would miss and fall back to `resolveFullRoster`.

## Files

- `src/lib/playback/client-ranking.ts` — `shouldAdoptRosterUpgrade`, remux 4K stays deferred after default = direct HD
- `src/components/video-player.tsx` — roster + Luna upgrade gates
- `src/lib/playback/source-quality.ts` — auto-default remux sink when direct HD exists
- `src/lib/playback/source-url-cache.ts` — 10 min URL cache
- `src/app/api/playback/[type]/[id]/route.ts` + `src/lib/playback/resolve-full.ts` — remember every returned source
- `src/app/api/transcode/route.ts` — cache first, roster on miss
- `src/lib/playback/debrid/realdebrid.ts` — `pickDebridVideoFile`
- `src/lib/playback/debrid/index.ts` — thread `candidate.title`
- `src/lib/playback/debrid/torrentio.ts` — `isMoviePackRelease`

## Tests run

```
bun test src/lib/playback/client-ranking.test.ts \
  src/lib/playback/source-quality.test.ts \
  src/lib/playback/debrid/torrentio.test.ts \
  src/lib/playback/debrid/rd-roster.test.ts \
  src/lib/playback/late-fourk.test.ts \
  src/lib/playback/source-url-cache.test.ts \
  src/lib/playback/debrid/pick-debrid-file.test.ts
```

Plus nearby: `source-bitrate`, `coordinator-shadow`, `ranking`, `no-token`, `expected-servers`, `quality-router`, `remux-prewarm`, `fast-debrid`.

**All pass.** Touched-file `tsc` clean (remaining repo errors are pre-existing scraper test `fetch` casts).

## Browser check

`bun scripts/browser/qa.ts flow watch-movie 550`

Expect: first frame from a direct HD source (no “Repackaging…” on auto). Remux 4K still listed; picking it remuxes without a long re-scrape if playback just resolved. A movie-pack Torrentio row should not appear / should not play a different title.