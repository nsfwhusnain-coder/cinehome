# UI critic MUST-FIX

Repo: `/Users/husnainali/cinehome`  
Did not edit `video-player.tsx` or `mini-services/stream-scraper/**`.

`bunx tsc --noEmit` is clean under `src/` (pre-existing scraper test fetch casts still fail outside this work).  
`bun test src/views/login-callback.test.ts src/components/season-picker.test.ts src/lib/profile-preferences.test.ts src/lib/playback/bloom-visuals.test.ts` — pass.

## Files

- `src/components/hero-carousel.tsx` — text title until logo `onLoad`; `sr-only` h1; S0 resume
- `src/views/movie-detail.tsx` — same title/logo first-paint; drop JustWatch row; picker can resume S0
- `src/views/login.tsx` — hex wash under oklch; last-profile tile + PIN; signup behind explicit control
- `src/hooks/use-progress.ts` — 401 returns to `/login?error=SessionExpired&callbackUrl=`
- `src/views/watch.tsx` — unauth CTA keeps callback; omitted S/E resumes progress (incl. S0); picker gets Specials
- `src/components/movie-card.tsx` — poster primary click → `/watch/...`; Info + title + `...` → detail
- `src/components/player/LoadingScreen.tsx` — always title + phase; optional `waitHint`
- `src/views/settings.tsx` — honest adult label + PIN to turn off; Ultra+fast sentence; Admin at bottom
- `src/components/season-picker.tsx` + `EpisodesPanel.tsx` — season ≥ 0, label “Specials”
- `src/views/person.tsx` — featured Play = highest **cast** popularity; TV uses continue S/E
- `src/views/browse-hub.tsx` — visible Movies/Shows h1 with a hero present
- `src/views/home.tsx` — red Netflix “N” badge removed (rows kept)
- `src/components/footer.tsx` + `src/app/globals.css` — hide Discord on `html[data-tv="1"]`

## QA

1. **First paint title** — Home/Movies hero shows the film name immediately. Logo replaces it only after decode; error keeps the text. Screen reader still has an h1.
2. **Login wall** — After one successful sign-in, `/login` is a large name tile + PIN (no retype). “Use a different profile” / “Create a household account” are explicit. Hisense still gets a hex wash if oklch is dropped.
3. **Session return** — Expire mid-watch: banner + after PIN land back on the same `/watch/...` path. Watch “Sign in” carries `callbackUrl`.
4. **Poster Play** — OK/click on a poster starts playback (`/watch/movie|tv/{id}`). Info / title / `...` still open detail. Continue cards unchanged.
5. **Wait copy** — Bloom always names the title and a phase. Settings Ultra + Fast: “Starts at 1080p, then switches to 4K when ready. Choose Maximum to wait for 4K.” Player can pass `waitHint` later; unused until then.
6. **Hide adult** — Label is “Hide TMDB adult-flagged titles”. Description says this is not R/TV-MA. Off requires current profile PIN. On is one click.
7. **Settings** — Members: account, install, household, playback, already-watched, About (TMDB only). Circuits / TMDB key / flags / pool / RD / provider live in a titled **Admin** block at the bottom.
8. **Specials** — Season 0 appears as “Specials” in detail picker and in-player episodes. Resume of S0 is kept. Autoplay still rolls over regular seasons only.
9. **Person Play** — Featured button is the highest-popularity **cast** credit. TV uses Continue S/E when present; otherwise `/watch/tv/{id}` (watch resumes).
10. **Hub identity / costume** — `/movies` and `/shows` show a visible h1. No red N lockup. No JustWatch logos next to Play. Footer Discord hidden on TV.

## Not in this pass

- Collapsing quality + 4K-startup into one control
- Radix Select → 10-foot list
- Hero dots size
- Player remux line (needs `video-player` to pass `waitHint`)
