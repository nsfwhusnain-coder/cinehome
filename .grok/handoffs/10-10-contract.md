# Absolute Cinema 10/10 implementation contract

**Repo:** `/Users/husnainali/cinehome` (GitHub SoT). NEVER edit `cinehome-sot`.
**No secrets. No console.log. Full TypeScript. Named constants. Minimal diffs.**
**Do not rewrite video-player.tsx. Extract only if a function already exists.**

## Product rules (do not violate)
- Poseidon/Kronos stay MP4-only native slots (no remux packing).
- Hades may be HEVC MKV.
- HLS/DASH never remux.
- TV HEVC trust stays for *inventory*; engine path must match decode.
- Resume playhead must survive source switches.
- Title/episode identity must use TMDB id, never display title.

## File ownership (hard)

### Player (`cinehome-player`)
`src/components/video-player.tsx`, `src/components/player/**`, `player-dock.tsx`, `player-controls.tsx`
`src/lib/playback/**` except you may touch `scraper.ts` ONLY for season-0 query mapping
`src/lib/playback/decode-capability.ts`, `device-profile.ts`, `first-frame-wall.ts`, `source-quality.ts`
`src/hooks/use-playback.ts` (season 0 + no extra resume toast if it lives here)

### Scraper (`cinehome-scraper`)
`mini-services/stream-scraper/**` only

### UI (`cinehome-ui`)
`src/views/**`, `src/components/navbar.tsx`, `mobile-dock.tsx`, `hero-carousel.tsx`, `movie-card.tsx`, `movie-row.tsx`, `card-overflow-menu.tsx`, `person-card.tsx`, `empty-states.tsx`, `tv-spatial-navigation.tsx`, `src/lib/tv-navigation.ts`, `src/lib/browse-categories.ts`, `src/app/(main)/**`, `src/app/globals.css` (TV-safe only), `src/lib/tmdb.ts` + `src/app/api/tmdb/**` for person routes, `src/views/login.tsx`, `src/views/watch.tsx` (resume toast only)

### Ops (general)
`scripts/deploy.sh`, `AGENTS.md`, `CINEHOME.md` (SoT paragraph only), delete `src/watch.tsx` + `src/player-store.ts` if unused, `.grok/skills/**` SoT paths inside THIS repo

## Do not
- Enable TRANSCODER_ENABLED
- Publish port 3030
- Re-add AllDebrid / Lordflix / Icefy / VidNest PW
- Touch `.env` or print tokens
- Drive-by refactors outside your list
