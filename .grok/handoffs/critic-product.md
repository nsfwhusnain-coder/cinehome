# Critic — Absolute Cinema (wave-1 “10/10”)

**Role:** living-room user on a Hisense 85" VIDAA + household operator  
**Repo:** `/Users/husnainali/cinehome`  
**Date:** 2026-08-14  
**Did not implement. Did not deploy.**

Judged from: `.grok/handoffs/{player,ui,scraper,ops,architect,10-10-contract}.md`, the listed UI files, chrome, prefs, and `.browser-qa/` captures against live `:4445`.

---

## VERDICT: REJECT

This is a competent scrape-to-player stack wearing three costumes (SaaS login, Netflix browse, admin console). From the sofa it does not yet behave like one household product. I would not call this 10/10. I would not hand the remote to a parent and leave the room.

Architect called the stitch **COHERENT WITH NOTES**. Coherent plumbing is not a shippable living room. The notes they left (S0 hidden, debrid S0→S1, login is a name field, hide-adult is `adult === true` only) are not footnotes. They are the product.

---

## Scores /10

| Lens | Score | One line |
|------|------:|----------|
| First 10 seconds (login → home) | **3** | Hunt-and-peck form, then a brown void with no title. |
| 10-foot TV | **5** | Real TV CSS exists. Login, Settings, Search, Selects, and card “Play” still think they are a laptop. |
| Play start (TTFF / 4K honesty) | **4** | Pretty wait. Default is Ultra+fast. You get 1080 remux while the UI talks about 4K. Remux may sit 52s. |
| Browse / search / person | **6** | Catalog is watchable. Poster Play is a lie. Person is an IMDb stub. Specials do not exist in the UI. |
| Settings / household | **3** | Gear icon opens an operator desk. “Hide adult” does not mean what a parent thinks. Quality copy is two knobs for one lie. |
| Coherence (one product vs patches) | **4** | LordFlix comments, Netflix “N” rails, JustWatch “Available on”, GitHub/Discord footer, AB loader, invite-code signup. |

**Weighted gut: 4.2 / 10.** Not a conditional. The trust breaks (Play, 4K, adult, first paint) are not polish.

---

## What is actually good (so the rest is not noise)

- Primary IA is right: Home · Movies · Shows · My List. Continue is a row, not a tab.
- Hero / detail Play is a white pill (`hero-carousel.tsx`, `movie-detail.tsx`). KD20 is held on those two surfaces.
- Login no longer mounts dock / footer / ambient / `pb-20` (`main-chrome.tsx`). Spatial nav leaves `/login` alone.
- Continue Watching is a real `<Link>` with a sibling remove. Progress bar is white.
- TV: Ken Burns killed, `[data-tv-safe]`, `[data-tv-first-focus]` on hero Play, root type scale + overscan, overflow 48px, VIDAA hex fallbacks. Someone sat on a panel.
- Detail page already learned “logo art cannot be the only title.” Hero did not copy that lesson.
- Watch-page Sonner resume toast is gone. One in-player notice.
- Season **0** now survives the API + watch URL. Player `mediaKey` is TMDB id. Same-height debrid sibling. Remux wall 52s is at least honest in code.
- Bloom copy (Searching / Preparing / Opening) does not invent a fake percent. Fight Club sequence is the best frame in the product.

None of that makes the first ten seconds or the 4K sentence acceptable.

---

## First 10 seconds — 3/10

**What happens on the 85".**

1. Front door is a **website sign-in card**, not a household wall. Name, PIN, Sign in / Sign up, invite code, “first account becomes the admin.” On VIDAA that is the on-screen keyboard for a name you already know. `autoFocus` is Name (`login.tsx`). Returning Dad does not want to type “Dad.”
2. Signup is on the same card as family unlock. A guest with a remote can tab to **Sign up**. That is not a living-room product. That is a SaaS trial.
3. Session-expired banner exists. Good. The path back does not. `useProgress` 401 → `signOut({ callbackUrl: "/login?error=SessionExpired" })` **drops the title**. Watch unauthenticated CTA is `navigate("/login")` with **no `callbackUrl`**. You were 40 minutes into a film. You are now at a name field. After PIN you land on `/`.
4. `safeCallbackPath` is correct security. It is unused by the two places a living-room session actually dies.
5. Login wash is **oklch-only** radial gradients (`login.tsx`). `globals.css` already documents that Hisense Chrome 76 **cannot parse oklch()**. On the target TV the “cinematic front door” is a black rectangle plus a form.
6. QA `2026-08-14T04-31-41-login-ok.png` (T+0 after auth) is a **black void** with rail bones. Two seconds later `…-home-logged-in.png` is a **brown soup**: meta, synopsis, Play, dots — **no title treatment, no backdrop, no posters**. Same frame is reused as `…-movies-hub.png`. Settled `home-settled.png` finally shows Spider-Man. The household’s first impression is “is it broken?”
7. `HeroTitle` swaps to a logo `<img>` the instant `pickTitleLogoUrl` returns a URL, with **no text fallback and no `sr-only` h1** (`hero-carousel.tsx`). Detail already fixed this exact bug. Home — the first screen — still has it. Until the PNG decodes, the 85" has a plot and a Play button for an unnamed film.

A Netflix clone that cannot name the film for the first several seconds has failed the first 10 seconds, period.

---

## 10-foot TV — 5/10

The TV CSS pass is real. The surfaces a remote actually uses after Play are not.

- **Hero dots are 6×6 px.** Un-hittable and unreadable at 3 m. They are in `[data-tv-safe]` and in the spatial graph. Congratulations: the remote can focus a grain of salt.
- **Poster “Play” is `pointer-events-none` decoration** over a link to `/{type}/{id}` (`movie-card.tsx`). Focus-within shows a white Play circle. OK opens **details**. On a TV that is a broken promise. Continue cards are more honest: they just play.
- **`...` on every poster is always visible on TV** (48px, in the graph). A hub row is now **two focus stops per title**. Ten titles = twenty D-pad hits before the next rail. Overflow opens a 220px portal menu. Spatial nav + portal + Radix is how remotes “do nothing.”
- **Settings / season / quality are Radix `<Select>`.** Laptop dropdowns. Unusable as a primary TV control.
- **Search autofocuses a text field.** Correct for a laptop. On VIDAA the first thing Search does is throw the system keyboard over the page you came to browse. Trending is eight tiny posters (`w-[120px]`) under a laptop prompt (“What would you like to watch?”).
- **Person avatars are `max-w-24` / detail cast is `w-20`.** Character names are `text-[10px]`. Root bump helps rem units; these are still postage stamps on 85".
- **Up-next** is a small bottom-center card, not TV-safe, 10s countdown. Fine on a MacBook. Lost in the overscan band on Hisense.
- **Footer still mounts on every non-login page** (Discord, DMCA, “we do not host”). On a TV you scroll past legal to find the end of the catalog.
- **Gear is always in the top pill.** One mis-click from Play and the household is in circuit tables (admin) or a wall of `<Select>`s (member).

TV work so far is “don’t clip the nav” and “don’t Ken Burns the SoC.” It is not a 10-foot information architecture.

---

## Play start / 4K honesty — 4/10

I will not score a pretty spinner as 4K.

**Default profile is Ultra (2160) + Fast start** (`DEFAULT_PROFILE_PLAYBACK_PREFERENCES`). Live `:4445` settings (05:53) still said *“Ultra is the default… Auto does the same hunt.”* New copy in `settings.tsx` is more words, same knot:

- **Auto** = start 1080, climb to 4K.
- **Ultra** = prefer 4K in the roster, **still HD first unless Maximum**.
- **4K startup** = Fast vs Maximum, *only* for remux.

So the household default named **Ultra** is: play 1080 now, maybe remux 4K later, wait up to **52 seconds** before failover, and if they tap a 4K Hades remux it will no longer silently hop to Kronos 1080 (player stitch — good). If they do nothing, they get the fast path.

**What the 85" actually showed**

- `loader-t0.png` — purple **AB** square, “SEARCHING”, Fight Club. Brand, not film.
- `loader-t1` / `t2` / `dock-settings` — dim still, **AB** still dominating, PREPARING / OPENING, “1 source.” Quality pane: **4K · searching**, 1080 ready.
- `stream-info.png` — Info: **1080p · SDR · MKV remux · Kronos** while the bloom still says PREPARING. That is the 4K sentence the product tells the room: *we are preparing something*; the something is a 1080 remux named after a god.
- `loader-barbie.png` — poster only. **No title. No phase. No source count.** A second loading language. Silent wait. On a TV this is “did Play work?”

Player notes the VIDAA native-HLS path **forfeits the JS quality floor**. Inventory “trusts HEVC”; the panel may still fail fMP4 HLS and sit on the 52s wall. The living room does not read `hevcNeedsNativePath`. It sees a spinner.

**TTFF product bar I would accept:** Play → picture in ~2–3s at a named quality (“1080p · 4K packing…”) → optional bump, announced. **What we have:** Play → brand bloom → 1080 remux → 4K maybe → 52s of patience on the path that was sold as Ultra.

I refuse 10/10 on that alone.

---

## Browse / search / person — 6/10

This is the least broken lens, which is how you get to 6, not 8.

**Browse**

- Home rails are a Netflix impression, including a red **N** “Movies on Netflix” / “TV Series on Netflix.” You are not Netflix. You are a household scraper. That badge asks “do I need a Netflix login?” and paints a trademark on a pirate catalog. Coherence and taste fail.
- Movies hub is the **same hero machine** as Home (`BrowseHub` → `HeroCarousel`). QA “movies-hub” frame is indistinguishable from home-logged-in. From the sofa, Home and Movies are the same brown rectangle until posters load. The visible `h1` is `sr-only`.
- Card hover Play (KD20) was implemented as a **decal**, not an action. See MUST-FIX 3.
- View-all hrefs exist. Adult filter is applied on hubs / view-all / home / person / search. The filter is the wrong promise (MUST-FIX 5).

**Search**

- Multi-search + People tab + in-app `/person/:id` is the first time this product has a person destination. Good.
- People in a **poster grid** (`grid-cols-3`…`6`) using a circular `PersonCard` is a layout accident. A face floats in a 2:3 cell.
- Genre discover is **movies only** (`discover/movie/${genre}`). Search “comedy” as a genre is a movie aisle.
- Recents are `localStorage` (`cinehome:search-recents`). Phone recents ≠ TV recents. Fine for v1; do not call it household.
- Empty-state trending inlines `adult !== true` instead of `withoutAdultTitles`. Same predicate, still a second copy of the rule.

**Person**

- Allowlisted TMDB proxy. In-app href. Error state. Featured white Play. This is a real page.
- Featured credit = `popularity * 10 + vote` over **cast + crew**. Play can start a forgotten crew credit, not the film they are famous for.
- `watchHref` for TV is **always `?season=1&episode=1`**. No resume. No S0. Tom Cruise Play is a movie; a TV actor Play is S1E1 even if Continue has S3E4.
- Filmography capped at 24. No “see all.” No TV first-focus on the Play pill (only `data-tv-safe` on the header).
- Back is `history.back()` or `/`. Deep-link from search then Back can dump you somewhere you do not remember.

**Specials**

Season 0 now plays if you type the URL. Season picker, episode panel, watch `tvSeasons`, hero/detail resume, and movie-detail `defaultTvEpisode` all **`season_number > 0`**. Christmas specials, crossovers, the extra the kid asked for — not in the product. Architect listed this as leftover. From the sofa it is a missing feature, not a note.

---

## Settings / household — 3/10

The gear is in the primary chrome. What it opens is not a household screen.

**Live `:4445` at 05:53** (`settings-debrid.png`, `settings-quality.png`): no Household card, Ultra default, copy that says Auto and Ultra are the same hunt. Either the wave is not on the TV yet or the first screen still lies. I judge both the live frame and the new code.

**New `HouseholdPreferencesSection`**

- Label: **“Hide adult titles.”** Description: “Hide titles TMDB marks as adult.”
- Implementation: `withoutAdultTitles` → `adult !== true`. TMDB `adult` is pornography, and rare on movie/TV discover (and discover already sends `include_adult: false`).
- What a parent hears: hide sex/gore/R from the kids’ Home.
- What happens: **Fight Club, Deadpool, Euphoria, and every TV-MA title stay.** Animation is correctly kept. The toggle can be flipped by **any signed-in profile** with no PIN. It is stored per `userId`, branded “Household.”
- Search **keeps people** even when `person.adult`.
- Turning it off is a toast, not a gated action.

That is a **trust defect**. Ship it like this and a parent will believe the kids are covered.

**Quality**

- Two independent dropdowns (Playback quality + 4K startup) plus a **Save** button. Hide-adult saves instantly. Two save models on one page.
- Default 2160 + fast. Ultra is not 4K. Maximum is the only honest “wait for 4K,” buried in the second dropdown, with helper text about “server repackaging.”
- Live dropdown labels were short and wrong. New labels are long and still wrong from 10 feet.

**Operator leak**

Same `/settings` for grokqa Member and for Admin: TMDB key, Real-Debrid token, circuit table, browser pool, HLS cache bytes, feature flags (`flag_ui_bottom_nav`), playback provider, accent color. RD block is admin-only (correct, no AllDebrid). Putting **circuit error strings and API tokens** behind the same gear a child can focus from Home is not a household product.

**Already watched**

A second tab. `localStorage`. Not the server Continue list. Mark-as-watched lives on the card `...` menu *and* here. Three lists: Continue, My List, Already watched. Phone and TV will disagree. The empty state tells you to tap a green check on My List — a desktop instruction.

**Switch user** → `/login` → “Already signed in” card → Sign out → type a name. Not profiles.

**About** links TMDB, **JustWatch**, GitHub. Detail page shows **“Available on” Netflix/Disney logos** from JustWatch while Play scrapes a free stream. That is the product explaining itself as a storefront for services it is bypassing.

---

## Coherence — 4/10

Four slices, four aesthetics, one brand mark.

| Costume | Where |
|---------|--------|
| SaaS auth | `/login` tabs, invite code, admin-first-user copy, toasts |
| Netflix | Hero, N-badge rails, white Play, glass pill nav |
| IMDb | Person bio / filmography / “Play {random credit}” |
| Datadog | Settings circuits, last scrape ms, proxy hit rate |
| LordFlix | Comments in `home.tsx`, `hero-carousel.tsx`, `navbar.tsx`, watch “full-viewport LordFlix” |
| AB | Loader center square that is bigger than the film’s name |

`NoProvider` still says “an admin can configure a provider.” The footer says you do not host files. The hero says PLAY. The card says PLAY and opens a wiki page. Settings says Ultra and plays 1080. Household says adult and means TMDB porn flag.

This is not one product. This is a week of fences with glue on two wires (anime `contentClass`, season 0). Those wires matter to playback. They are invisible on the 85".

---

## MUST-FIX

I would refuse 10/10 until these are true in the living room, not in a handoff.

1. **Name the film in the first paint.** Hero must show a text title until the logo PNG has loaded (copy the detail-page pattern: visible fallback or `sr-only` h1 + reserved space). Home and Movies must not render as brown soup + synopsis. If the backdrop is late, show a titled scrim, not an anonymous plot.

2. **Login is a profile wall, not a form.** Faces or large name tiles + PIN on the chosen person. Sign up / invite / “first user is admin” off this screen. Returning session-expired must return to the **same title** (`callbackUrl` on watch 401 and on the watch “Sign in” button). Kill oklch-only paints on the Hisense path.

3. **Poster Play must Play.** The white circle is a play affordance (KD20). OK/click on a focused poster should start playback (movie → `/watch/movie/{id}`, TV → resume episode or S1E1), not open details. Details stay on Info / `...` / a second action. Decorative `pointer-events-none` Play is a ship blocker.

4. **One honest 4K sentence, on screen while waiting.** Default Ultra+Fast must say what is playing: e.g. “1080p now · packing 4K” or do not call it Ultra. Do not leave Info on **1080p Kronos remux** while the bloom implies a higher ritual. Barbie-style silent poster is banned. 52s remux is allowed only if the room is told it is packing, not “Opening.” Collapse quality + 4K-startup into one living-room control (or make Maximum the only way Ultra means 4K, and say so on the Play side, not in a second `<Select>`).

5. **“Hide adult titles” must match parent English — or change the label.** Either filter on certification / TV-MA / R / NC-17 (and document it), or rename to “Hide TMDB adult-flagged titles” and **PIN-gate the off switch**. Per-user toggle branded Household, no PIN, that leaves Fight Club on Home, is a reject. Kids must not be able to turn it off from the gear.

6. **Settings cannot be the admin console.** Household + playback for every profile: three big targets (quality, subtitles, hide-mature). RD token, TMDB key, circuits, flags, pool — **Admin only, not the same scroll** as “Your Account.” Radix selects are not the TV UI for this.

7. **Specials are in the product or they are not.** If S0 plays via URL, it is in the season picker, episode panel, and resume. If debrid still maps `season > 0 ? season : 1`, do not mix that sibling into an S0 play (architect risk #1 — this is user-visible wrong episode). Hidden S0 is a broken show page, not a backlog item.

8. **Person Play is the title they are known for, or it is not Play.** Do not start a crew credit. TV Play must honor Continue (same resume helper as hero/detail). Do not hardcode S1E1.

9. **Home / Movies / Shows must not be the same untitled hero.** After the first D-pad from Home, the room should know which hub they are in. Visible heading or distinct hero set. “Movies” as `sr-only` behind the same Spider-Man slide is a fake hub.

10. **Stop dressing this as Netflix-or-JustWatch.** Remove the red **N** “on Netflix” lockup. “Available on” storefront logos next to a scrape Play is a coherence and trust problem. Footer Discord/GitHub do not belong on the TV catalog.

---

## Not MUST-FIX (still ugly; will not by themselves flip this verdict)

- Anime `contentClass` fail-open if TMDB is down (correct trade).
- Health registry `contentClass` still `movie|tv`.
- Historic `docs/*` cinehome-sot mentions.
- Continue `/continue` trash vs home `...` inconsistency.
- Heart icon used as a genre marker on the hero.
- Already-watched `localStorage` vs server Continue (fix after the lists have names a parent can understand).
- Search recents not synced.
- Up-next 10s card chrome.
- Card `scale-105` on TV focus clipping neighbors.
- Six-item mobile dock at `text-[10px]`.
- CinePro 8s timeouts (ops: often `cinepro_timeout_8000`) — user only feels “Searching” longer.

---

## Evidence

**Handoffs:** `ui-10-10.md`, `player-10-10.md`, `scraper-10-10.md`, `ops-10-10.md`, `architect-10-10.md`, `10-10-contract.md`.

**Code (primary):**  
`src/views/{login,home,continue-watching,person,settings,watch,search,movie-detail,browse-hub}.tsx`  
`src/components/{movie-card,hero-carousel,person-card,navbar,mobile-dock,card-overflow-menu,season-picker,footer,tv-spatial-navigation}.tsx`  
`src/app/(main)/main-chrome.tsx`, `src/app/globals.css`  
`src/lib/{tmdb-filters,profile-preferences,continue-watching,playback/bloom-visuals}.ts`  
`src/hooks/{use-hide-adult,use-progress}.ts`, `src/app/api/preferences/route.ts`

**QA frames:**  
`.browser-qa/2026-08-14T04-31-41-login-ok.png` (black)  
`.browser-qa/2026-08-14T04-31-43-home-logged-in.png` (untitled brown hero)  
`.browser-qa/2026-08-14T04-31-44-movies-hub.png` (same)  
`.browser-qa/home-settled.png` (logo finally there)  
`.browser-qa/2026-08-14T05-53-11-settings-debrid.png`, `settings-quality.png` (no Household; Ultra = Auto)  
`.browser-qa/loader-t0.png`, `loader-t1.png`, `loader-t2.png`, `loader-barbie.png`, `dock-settings.png`, `stream-info.png` (AB bloom; 1080 remux Kronos; Barbie silent)

---

## Close

Wave-1 made the pipes one system. The living room still meets four products and two lies (Play, 4K/adult). **REJECT.** Come back when the first ten seconds can name the film, Play plays, Ultra means what it says, and a parent can trust the Household switch without reading TMDB docs.
