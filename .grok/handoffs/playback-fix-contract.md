# Playback / source identity fix — research contract

Repo: `/Users/husnainali/cinehome`. Dig completed 2026-08-14. IMPLEMENT these, do not wander.

## What is actually broken

### Repackaging is slow (three stacked costs)

1. **Cold-start upgrade steals HD for a remux 4K.**  
   `pickClientStartupSource` correctly starts direct 1080 when Ultra+fast. Then the roster-reconciliation effect in `video-player.tsx` (~1898) treats remux 2160 as `betterHeight` and **switches to Hades before first frame**. That is the "Repackaging…" the user sees.

2. **Remux route re-resolves the entire roster** (`resolveFullRoster` in `/api/transcode`) just to look up `sourceId` → URL. Cold that is a full scrape + Torrentio/RD (seconds to tens of seconds) *before ffmpeg even starts*.

3. **Remux of a 4K MKV is I/O-bound** (`-c copy` still downloads the file). First playlist waits up to 60–75s. Fine as a *user pick*; fatal as the auto default.

### Wrong movie

`resolveDebridDirectLink` (`realdebrid.ts` ~157): Torrentio `fileIdx` is 0-based, RD `id` is 1-based. On mismatch it **`pickLargestVideoFile`**. Season packs / collections / "Complete" torrents then unrestrict the biggest file, which is often a *different* title. Size validation only rejects <50MB movies, so a full wrong feature passes.

`MOVIE_NON_FEATURE_PATTERN` only drops extras/featurettes, not packs.

Duration gate is conservative (trailer-sized only). A 2-hour wrong movie vs a 2-hour requested title is not caught.

## File ownership

- **Player:** `src/components/video-player.tsx`, `src/lib/playback/**` including debrid, remux route, resolve-full. NOT stream-scraper.
- **Scraper:** `mini-services/stream-scraper/**` only — duration probe / pack-ish poison if any.

## Do not
- Enable TRANSCODER_ENABLED
- Undo Poseidon/Kronos MP4-only
- Auto-start remux 4K when direct HD exists
- `console.log` / secrets
