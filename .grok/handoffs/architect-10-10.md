# Architect 10/10 — wave-1 cohesion

**Repo:** `/Users/husnainali/cinehome` (not cinehome-sot)
**Date:** 2026-08-14
**Role:** glue only. No transcoder. Port 3030 unpublished. Poseidon/Kronos stay MP4-only.

## Verdict: COHERENT WITH NOTES

Four slices were independently correct inside their file fences. Two product wires were dead without a stitch (anime query never left the app; playback API + watch page still coerced season 0 → 1). Those are now stitched. Remaining notes are real but out of the “make it one product” bar.

---

## What was already coherent

### Player
- Hisense/VIDAA native HLS when MSE HEVC is absent (`hevcNeedsNativePath`).
- Remux first-frame wall 52s; zero-progress resume 32s vs cold 22s.
- `findDirectDebridAlternative` same-height only — user Hades remux 4K no longer hops to Kronos 1080.
- `mediaKey` is `${mediaType}:${tmdbId ?? tvId}:${season}:${episode}` — title hydration cannot wipe resume.
- Unavailable delivery does not invent `/api/transcode`. Remux prewarm requires `#EXTM3U`.
- `use-playback.ts` `tvQueryIndex` already kept 0. Scraper client already sent finite 0.
- In-player resume notice remains; watch-page Sonner “Resumed from …” is gone. No double toast.

### Scraper
- CinemaOS empty 200 is a title miss, not an outage. Real 5xx/timeout still trip the circuit.
- CinePro `/v1/proxy` is not assumed HLS; probe sniffs body/type.
- Shared `provider-outage.ts` on vixsrc/videasy/vidrock/notorrent/cinemaos.
- Healthy API roster (≥4 measured) skips Playwright (Vidking ~17s, pool size 1).
- `/scrape` + `/prefetch` accept `contentClass=anime` / TV `anime=1` and fold it into `resultCacheKey`. Ranking boost is Vidrock/NoTorrent at equal height only.
- Season 0 already valid on the scraper HTTP boundary.

### UI
- Login chrome: `main-chrome.tsx` hides dock, footer, ambient, extra `pb-20` on `/login`. `mobile-dock` and TV spatial nav also skip `/login`. Name field still `autoFocus`.
- `safeCallbackPath` rejects `//evil` and `/login` loops. Session-expired banner wired.
- Continue Watching: real `<Link>`, sibling remove, white progress.
- Hide adult: `UserSetting` `hide_adult` default ON. GET `/api/preferences` spreads playback prefs + `hideAdult`. PATCH `{ hideAdult }` only writes that KV and does not touch playback rows. Combined PATCH still returns both.
- `withoutAdultTitles` is `adult !== true` — missing/`false` stay. Animation is not adult. Home, hubs, view-all, person filmography all use the helper. Search uses the same predicate (persons kept even if `person.adult`).
- Person: allowlisted `GET /api/tmdb/person/:id` and `.../combined_credits` only (unknown TMDB paths 404). `PersonCard` href is `/person/:id`.
- TV: static hero, `[data-tv-safe]`, `[data-tv-first-focus]` on hero Play.

### Ops
- `deploy.sh` `--delete` excludes `transcode-cache/`, `.browser-qa/`, `.runtime-cache/`.
- SoT docs (`AGENTS.md`, `CINEHOME.md`, cinehome-dev/deploy skills) point at `/Users/husnainali/cinehome`.
- Dead twins `src/watch.tsx` and `src/player-store.ts` are gone. Remaining imports are `@/views/watch` and `@/stores/player-store`.

---

## What I had to stitch

### 1. Anime flag now leaves the app
Scraper ranking for anime was dead: nothing in Next sent `contentClass=anime`.

**Wire:**
- Pure classifier `src/lib/tmdb-anime.ts` — Animation (16) **and** (origin JP / `original_language` ja|jpn / keyword or genre name contains `anime`). Western animation stays on the default ranker. Live-action JP is not anime.
- Light TMDB fetch `tmdb.animeSignals(type, id)` = `/{type}/{id}?append_to_response=keywords` only (not full `movieDetails`).
- `resolvePlaybackContentClass` in `src/lib/playback/content-class.ts` — `cachedFetch` 6h, fail-open (TMDB miss → no class, playback still works).
- Playback route classifies **before** cache lookup, in parallel with profile prefs.
- `ScraperPlaybackProvider` sets `contentClass=anime` on `/scrape` and `/prefetch`.
- `playbackCacheKey` + `rawScrapeCacheKey` append `:anime` so default `streamUrl` cannot leak across classes.

No MAL / Anixtv / Consumet.

### 2. Season 0 actually reaches the scraper
Player + scraper client were patched; the API and watch page still killed specials.

| Site | Was | Now |
|------|-----|-----|
| `src/app/api/playback/[type]/[id]/route.ts` | `season < 1 → 1` | `tvQueryIndex` (0 stays 0; missing/NaN/negative → 1) |
| `src/views/watch.tsx` | `season && season > 0 ? season : 1` + URL replace + progress drop | same helper; URL `?season=0` kept; progress saves S0 |
| `src/lib/playback-preresolve.ts` | hover prefetch coerced 0 → 1 | `tvQueryIndex` |
| `src/hooks/use-playback.ts` | already correct | re-exports shared helper |

Shared helper: `src/lib/playback/tv-index.ts`.

### 3. Browser skill SoT path
`.grok/skills/cinehome-browser/SKILL.md` still `cd`’d to `cinehome-sot`. Cwd + screenshot path are now `/Users/husnainali/cinehome`.

### 4. Hide-adult helper extracted for tests
`withoutAdultTitles` lives in `src/lib/tmdb-filters.ts` and is re-exported from `tmdb.ts`. Behavior unchanged. Tests prove default ON does not drop Animation or unflagged titles.

---

## Integration checklist (the nine gaps)

1. **Anime flag** — wired. Route classifies; scraper client sends query; cache keys include class.
2. **Season 0** — API no longer coerces 0 → 1. Watch + preresolve match.
3. **Hide adult** — prefs GET/PATCH keep playback KV. Filter is `adult === true` only. Person/search/hubs/home share the helper (search keeps people).
4. **Login chrome** — no dock/footer/ambient/`pb-20`. Name autofocus intact. TV nav does not steal focus.
5. **Person TMDB proxy** — still an allowlist, not an open proxy. Only the two person routes were added. In-app card href.
6. **Player remux + UI resume** — watch toast gone; player notice stays; `mediaKey` is tmdbId.
7. **Dead file imports** — none. Canonical store/view remain.
8. **Browser skill SoT** — fixed.
9. **Tests** — added/updated:
   - `src/lib/tmdb-anime.test.ts`
   - `src/lib/tmdb-filters.test.ts`
   - `src/lib/playback/tv-index.test.ts`
   - `src/lib/server-cache.test.ts` (anime partition)
   - `src/lib/playback-preresolve-url.test.ts`
   - `src/hooks/use-playback-key.test.ts` (negative index)

   Parent should run:

   ```bash
   cd /Users/husnainali/cinehome
   bun test \
     src/lib/playback/first-frame-wall.test.ts \
     src/lib/playback/source-quality.test.ts \
     src/lib/playback/decode-capability.test.ts \
     src/lib/profile-preferences.test.ts \
     src/views/login-callback.test.ts \
     scripts/deploy-safety.test.ts \
     mini-services/stream-scraper/providers/circuit.test.ts \
     mini-services/stream-scraper/default-source-rank.test.ts \
     src/lib/tmdb-anime.test.ts \
     src/lib/tmdb-filters.test.ts \
     src/lib/playback/tv-index.test.ts \
     src/lib/server-cache.test.ts \
     src/lib/playback-preresolve-url.test.ts \
     src/hooks/use-playback-key.test.ts
   ```

---

## Remaining risks for critics

1. **Debrid Torrentio still maps `season && season > 0 ? season : 1`.** Specials deep-links get the correct **embed** scrape. RD/TorBox siblings for that request would be S1. Out of the API-route stitch; do not mix debrid S1 into an S0 player pick without a follow-up.
2. **Season pickers still hide S0** (`season-picker`, `EpisodesPanel`, watch `tvSeasons` filter, movie-detail default). Deep link `/watch/tv/{id}?season=0&episode=1` works. There is no in-app Specials row this iteration.
3. **Anime classify adds one light TMDB GET** on a cold playback resolve (cached 6h process-local). Fail-open. If TMDB is down, anime ranking silently stays default — better than blocking Play.
4. **Login autofocus is Name, not PIN.** UI 10/10 QA text: “Name field still auto-focuses.” Do not “fix” this to PIN.
5. **Search empty-state trending** still inlines `adult !== true` instead of calling `withoutAdultTitles`. Same predicate; persons are not in that list.
6. **Health registry `contentClass`** on the playback route is still `movie | tv` (media type), not `anime`. Scraper ranking is the anime wire; client health is unchanged.
7. **This agent could not execute `bun test`** (no shell in this subagent). Parent must run the command above before calling it done.
8. **Historic `docs/*` still mention cinehome-sot** (ops leftover, not this stitch).

---

## Files

| Path | Action |
|------|--------|
| `src/lib/tmdb-anime.ts` | CREATE |
| `src/lib/tmdb-anime.test.ts` | CREATE |
| `src/lib/tmdb-filters.ts` | CREATE |
| `src/lib/tmdb-filters.test.ts` | CREATE |
| `src/lib/playback/tv-index.ts` | CREATE |
| `src/lib/playback/tv-index.test.ts` | CREATE |
| `src/lib/playback/content-class.ts` | CREATE |
| `src/lib/playback-preresolve-url.test.ts` | CREATE |
| `src/lib/tmdb.ts` | MODIFY — `animeSignals`, origin fields, re-export filter |
| `src/lib/playback/types.ts` | MODIFY — `PlaybackRequest.contentClass` |
| `src/lib/playback/scraper.ts` | MODIFY — send `contentClass=anime`, cache key |
| `src/lib/server-cache.ts` | MODIFY — `:anime` suffix on raw + playback keys |
| `src/lib/server-cache.test.ts` | MODIFY |
| `src/app/api/playback/[type]/[id]/route.ts` | MODIFY — season 0 + classify + pass class |
| `src/hooks/use-playback.ts` | MODIFY — shared `tvQueryIndex` |
| `src/hooks/use-playback-key.test.ts` | MODIFY |
| `src/views/watch.tsx` | MODIFY — season 0 URL + progress |
| `src/lib/playback-preresolve.ts` | MODIFY — season 0 prefetch URL |
| `.grok/skills/cinehome-browser/SKILL.md` | MODIFY — SoT cwd |

Not touched: `video-player.tsx`, `mini-services/stream-scraper/**` (already correct), `.env`, transcoder, port 3030, Poseidon/Kronos remux ban.
