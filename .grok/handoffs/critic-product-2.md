# Critic — Absolute Cinema (product re-audit)

**Role:** living-room user on a Hisense 85" VIDAA + household operator  
**Repo:** `/Users/husnainali/cinehome`  
**Date:** 2026-08-14  
**Did not implement. Did not deploy.**

Judged from: `.grok/handoffs/critic-product.md` (prior REJECT), `.grok/handoffs/ui-critic-fix.md`, and the files those claims point at.  
Prior frames in `.browser-qa/` are **pre-fix** (`last-run` 05:53). They are not evidence of this pass. Playback/debrid S0 was re-checked in code (`torrentio.buildKindPath` + tests).

---

## VERDICT: CONDITIONAL

The ten living-room lies that caused REJECT are **not still false**. Play plays. The hero names the film before the logo decodes. Hide-adult speaks TMDB English and PIN-gates off. Members do not get a circuit table. Specials exist. Person Play is a cast credit and can resume. Hubs say Movies / Shows. The red N and JustWatch row are gone.

This is no longer “four costumes and two lies.” It is still not a 10/10 household product. The leftover that keeps this off PASS is the **same 4K sentence, still not on the wait screen**, plus a pile of 10-foot leftovers the first critic already refused to promote to MUST-FIX.

I would hand a parent the remote **with a warning**, not leave the room.

---

## Scores /10

| Lens | Was | Now | One line |
|------|----:|----:|----------|
| First 10 seconds (login → home) | 3 | **7** | Returning tile + PIN; text title on the hero; first visit is still a name field. |
| 10-foot TV | 5 | **6** | Poster OK now Plays. Settings/Search/Selects/dots still think they are a laptop. |
| Play start (TTFF / 4K honesty) | 4 | **6** | Silent Barbie is banned. Ultra+fast is honest in Settings. Bloom still says Searching / Preparing / Opening. |
| Browse / search / person | 6 | **7** | Play, Specials, hub h1, cast Play + resume. Search is still a laptop prompt. |
| Settings / household | 3 | **7** | Label + PIN + Admin block are real. Two quality knobs and Radix remain. |
| Coherence (one product vs patches) | 4 | **6** | N lockup and storefront row gone. Rails still say “on Netflix.” Admin is still Datadog for admins. |

**Weighted gut: 6.5 / 10.** CONDITIONAL, not PASS. Not REJECT — none of the previous ten MUST-FIX items is still a false living-room claim.

---

## Previous MUST-FIX

### 1. Name the film in the first paint — DONE

`HeroTitle` (`hero-carousel.tsx`) keeps a visible `<h1>` until `logoReady && !logoFailed`. Logo `<img>` is `hidden` until `onLoad`; `onError` keeps the text. Same pattern on detail (`movie-detail.tsx`). Screen reader keeps the h1 when the logo takes over (`sr-only`).

The brown-soup failure was “logo URL exists, PNG not decoded, no title.” That path is closed. Backdrop can still arrive late; the room at least has a name and a Play.

### 2. Login is a profile wall, not a form — DONE

After one successful sign-in, `cinehome:last-profile` drives a large initial tile + PIN (`autoFocus`, `data-tv-first-focus`). Signup / invite sit behind “Create a household account,” not on the returning card. Hex wash is its own layer under oklch (`LOGIN_WASH_HEX` then `LOGIN_WASH_OKLCH`) so Chrome 76 can drop oklch and still paint.

Session return:

- `useProgress` 401 → `/login?error=SessionExpired&callbackUrl=` + `safeCallbackPath` of the current path (query string kept, including `season=0`).
- Watch unauth CTA → `/login?callbackUrl=` of the watch URL (S/E kept when present).
- `safeCallbackPath` tests cover watch query + open-redirect rejects.

Leftover (not a re-open of this item): there is still no household face grid. First visit and “Use a different profile” are a name field. `useWatchlist` 401 still signs out to `/login` with no callback.

### 3. Poster Play must Play — DONE

Poster `href` is `/watch/movie/{id}` or `/watch/tv/{id}`. `aria-label` is `Play {title}`. Info (hover), title, and `...` go to detail (`tabIndex={-1}` on Info/title so TV keeps one primary stop). The white circle is still `pointer-events-none` paint — the **link under it** now matches the affordance. Continue cards were already honest.

Leftover: omitted TV S/E means `tvQueryIndex(undefined) → 1`, so watch may scrape S1E1 for a beat before `router.replace` applies Continue (including S0). Continue cards themselves pass S/E.

### 4. One honest 4K sentence, on screen while waiting — DONE with leftover

Done:

- Bloom always prints a title (`title.trim() || "Loading"`) and a phase. Barbie silent poster is banned.
- Settings Ultra + Fast now says: “Starts at 1080p, then switches to 4K when ready. Choose Maximum to wait for 4K.”
- Player already computes “Preparing 4K…” / “Repackaging for your browser…” (`video-player.tsx` `loadingStatus`).

Not done (leftover, **not** a re-REJECT):

- `waitHint` is declared on `LoadingScreen` and **never passed**.
- Display copy is `waitHint || bloomPhaseCopy(phase)`. `bloomPhaseCopy` is only Searching / Preparing / Opening. The player’s honest `status` is used only to pick the phase, then thrown away.
- Quality + 4K startup are still two Radix `<Select>`s. Collapse was explicitly out of the UI pass.

Default is still Ultra (2160) + fast. The room is told the truth **in Settings**. On the 85" wait card it still looks like a ritual.

### 5. Hide-adult English + PIN off — DONE

Label: “Hide TMDB adult-flagged titles.” Description says rare TMDB flag, not R/TV-MA, Fight Club stays. On = one click. Off = AlertDialog + current profile PIN via `signIn("credentials")`, then PATCH.

Leftover: PATCH `/api/preferences` `{ hideAdult: false }` has **no PIN**. Any signed-in profile’s PIN works, not a parent PIN. On a TV remote that is still a gate. In DevTools it is not.

### 6. Settings cannot be the admin console — DONE

Members get: account, install, household, playback, already-watched, About (TMDB only).  
`isAdmin` wraps a titled **Admin** block at the bottom: status, circuits/pool, RD, TMDB key, provider, accent, flags, users.

Leftover: same URL, same scroll for the operator. Radix Selects are still the TV UI. Two save models (toggle vs Save). Not “three big targets.”

### 7. Specials are in the product — DONE

- `SeasonPicker` / `EpisodesPanel`: `season_number >= 0`, label “Specials.”
- Watch passes S0 in `tvSeasons`. Resume helpers keep `season >= 0`.
- Omitted S/E resumes Continue, including S0, else S1E1.
- Hero / detail resume the same way. Detail Play can start S0.
- Autoplay rollover still skips S0 (stated, correct).
- Debrid: `buildKindPath` uses `tvQueryIndex`; test locks `stream/series/{imdb}:0:1.json`. Scraper client keeps finite `0`.

Leftover: detail Play copy is `Play S0E1`, not “Play Specials.”

### 8. Person Play is a cast title — DONE

Featured = highest **cast** popularity (crew ignored), poster preferred. TV `watchHref` uses Continue S/E when present, else `/watch/tv/{id}` (watch resumes). No hardcoded S1E1 when continue exists.

Leftover: “highest popularity” is not “known for.” No `data-tv-first-focus` on the pill.

### 9. Hubs must not be the same untitled hero — DONE

`BrowseHub` renders a visible `<h1>{title}</h1>` (Movies / Shows) even when a hero is present. Not `sr-only`. Home stays untitled; that is the home.

### 10. Stop dressing as Netflix / JustWatch — DONE

- No red N lockup in `MovieRow` / home. Rails kept (“Movies on Netflix” / “TV Series on Netflix”) — that was the stated pass.
- Detail: no JustWatch / “Available on” storefront row next to Play.
- About: TMDB only (GitHub / JustWatch links gone).
- Footer Discord is `.footer-social`; `html[data-tv="1"] .footer-social { display: none }`. DMCA stays. GitHub icon already gone.

Leftover: trademark still in rail titles. LordFlix comments still in home/hero/watch. AB mark still fills bloom when there is no poster.

---

## Remaining MUST-FIX (ship-blockers)

**None.** Every previous MUST-FIX is true in code, or true with a leftover that does not restore the original lie (Play→detail, unnamed hero, hide-adult as kids-mode, member circuit table, hidden S0, crew Play, fake hub, N/JustWatch next to scrape Play).

---

## Leftovers (will not flip this to REJECT)

These are the small leftovers that keep the verdict CONDITIONAL instead of PASS:

1. **Wait bloom still flattens 4K copy.** Pass `waitHint={loadingStatus}` (or print `status` when it is more specific than the three phase words). Ultra+fast / 52s remux must say packing on the card, not only in Settings. Do not collapse this into another Settings paragraph.
2. **Two quality dropdowns + Radix.** Still a laptop control. Collapse or leave it — not a new blocker.
3. **Hero dots are still 6×6.** Un-hittable at 3 m. Already not MUST-FIX.
4. **Two TV focus stops per poster** (`...` always visible). Play is now the primary stop; overflow is still a tax.
5. **First visit / switch user is still a name field.** Returning path is the one that failed last time.
6. **Hide-adult off is client-PIN only.** API trusts the session.
7. **Poster → `/watch/tv/{id}` can scrape S1E1** until replace. Continue cards are fine.
8. **No new Hisense frames.** Code says the title is there. The 85" has not signed the form.

Not MUST-FIX (same list as last time): already-watched `localStorage`, search recents, up-next chrome, six-item dock, CinePro 8s, anime fail-open.

---

## Evidence (code)

| Item | Primary proof |
|------|----------------|
| 1 | `src/components/hero-carousel.tsx` `HeroTitle`; `src/views/movie-detail.tsx` logo gate |
| 2 | `src/views/login.tsx`; `src/hooks/use-progress.ts`; `src/views/watch.tsx` Sign in; `src/views/login-callback.test.ts` |
| 3 | `src/components/movie-card.tsx` `playHref` vs `detailHref` |
| 4 | `src/views/settings.tsx` Ultra+fast sentence; `src/components/player/LoadingScreen.tsx` `waitHint`; `video-player.tsx` `LoadingScreen` call (no `waitHint`) |
| 5 | `HouseholdPreferencesSection` in `src/views/settings.tsx` |
| 6 | `SettingsView` member stack vs `{isAdmin ? <section>Admin` |
| 7 | `season-picker.tsx`, `EpisodesPanel.tsx`, `watch.tsx` `tvSeasons` / resume; `torrentio.ts` `tvQueryIndex` + test |
| 8 | `src/views/person.tsx` `collectFilmography` cast-only featured + `watchHref` |
| 9 | `src/views/browse-hub.tsx` visible `h1` |
| 10 | `home.tsx` (no N node); no JustWatch row in detail; `globals.css` `.footer-social`; About TMDB-only |

---

## Close

Last time the living room met two lies (Play, 4K/adult) and a form. Those lies are gone in the tree. **CONDITIONAL** until the wait card says what Ultra+fast is actually doing — one wired `waitHint`, not another settings essay — and until someone looks at a post-fix screenshot on the panel. Then this can be PASS without pretending it is 10/10.
