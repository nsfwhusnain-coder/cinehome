# CineHome Design System v3 — "Clean, Apple-like" Plan

Status: **planning only — no implementation yet**. This document is the output of two research passes (screenshots of lordflix.org across more page types + a strict file-by-file audit of CineHome's own codebase after the v2 redesign) and defines exactly what changes, why, and in what order.

## Sources this plan is built from

1. `cinehome-vs-lordflix-report.html` (artifact) — first-pass page-by-page gap analysis (home, detail, search, player).
2. `/tmp/ui_research/round2/lordflix/` — second-pass screenshots: TV show detail page, episode browsing UI, mobile detail page, and a **card hover state** (not capturable in the first pass's full-page static screenshots).
3. `/tmp/ui_research/round2/codebase-audit.md` — full file-by-file audit of what the three parallel v2-redesign forks actually shipped, including real bugs, not just style opinions.
4. General, well-established design-industry knowledge of Apple's platform conventions (8pt spacing grid, banded type scale, spring-based motion for direct manipulation) — used as an objective second reference point alongside lordflix's specific execution, since "Apple-like" should mean more than "whatever one competitor happens to do."

---

## Part A — Fix what's already broken

This runs **before** any new visual work. Building new patterns on top of an inconsistent base compounds the inconsistency. All items below are from the codebase audit and are real bugs or drift, not opinions.

| # | Fix | File(s) | Why first |
|---|---|---|---|
| A1 | 7+ Framer Motion `transition` props set `duration` but omit `ease`, silently using the default curve instead of the intended one | `movie-detail.tsx`, `tv-season.tsx`, `continue-watching.tsx`, `watchlist.tsx`, `search.tsx` | Motion is inconsistent *right now* — highest-visibility bug in the set |
| A2 | Create `src/lib/motion.ts` exporting `EASE_OUT_EXPO = [0.16, 1, 0.3, 1]` as a named constant; replace every copy-pasted magic array with the import | all files using the curve (8+) | Prevents A1 from recurring — the bug exists *because* there's no single source of truth |
| A3 | `movie-detail.tsx` has a stale local `LoadingSkeleton()` (still `rounded-lg`) actively rendered, duplicating an already-correct, unused `DetailPageSkeleton` in `skeletons.tsx` | `movie-detail.tsx` | Dead code + visibly stale radius |
| A4 | `watchlist-button.tsx`'s `variant="full"` hardcodes `rounded-md` at the source; only looks right today because its one caller overrides it | `watchlist-button.tsx` | Latent bug — will resurface the next time this variant is used |
| A5 | One Family Members row in Settings uses `rounded-lg` while its 8 sibling surfaces use `rounded-2xl` | `settings.tsx:458` | One-line fix, visibly inconsistent within a single page |
| A6 | `font-display` (Montserrat) is correctly applied to every page's primary heading but missed on **sibling/alternate states** of those same pages | `continue-watching.tsx`, `watchlist.tsx`, `settings.tsx`, `watch.tsx` (see audit §3 for exact line numbers) | Same label, same semantic role, inconsistent treatment depending on auth/data state |
| A7 | Codify the spacing-rhythm split as an explicit rule instead of accidental fork drift: **wide media-browsing pages** (home, detail, search) use the `mt-10`–`mt-12` rhythm; **narrow single-column form pages** (settings, login) use `space-y-6` | none (documentation decision) — then verify all pages actually match whichever rule is chosen | Turns an unreconciled accident into an intentional, documented pattern |

---

## Part B — Design tokens ("north star" spec)

Concrete numbers, not adjectives. Everything in Part C references this table.

### Spacing
Already on an 8px-derived scale via Tailwind (4px increments) — no scale change needed, just the explicit rule from A7:
- **Tight** (icon-to-label, badge padding): `gap-1.5` / `gap-2` (6–8px)
- **Component-internal** (card padding, row gaps): `gap-3` / `gap-4` (12–16px)
- **Narrow-page section rhythm** (settings, login): `space-y-6` (24px)
- **Wide-page section rhythm** (home, detail, search, watchlist, continue-watching): `mt-10`–`mt-12` (40–48px)

### Type
Current scale already matches a banded (not continuous) approach — confirmed fine, not a gap:
- Hero title: `text-5xl` → `text-7xl`, `font-display`
- Page H1: `text-2xl` → `text-3xl`, `font-display`
- Section heading: `text-xl`, `font-display`
- Body: `text-sm` / `text-base`, default sans
- Meta/micro: `text-xs`, default sans, sometimes `font-mono tabular-nums` for numbers

### Motion
- `EASE_OUT_EXPO = [0.16, 1, 0.3, 1]` — page transitions, content fade-ins, anything **300–400ms**
- Direct-manipulation feedback (hover/tap on cards, buttons) — **150–250ms**, and consider switching from cubic-bezier to a **spring** (`type: "spring", stiffness: 400, damping: 25`ish) for a more physical, Apple-like feel with a touch of overshoot. Cubic-bezier ease-out is fine for content appearing; spring is more correct for things that feel *touched*.
- Ambient/background motion (hero Ken Burns zoom) — `linear`, slow, already correct, leave as-is

### Radius
Already-correct scale, per audit — just needs the Part A fixes applied:
- `rounded-full`: pills, buttons, avatars
- `rounded-2xl`: page-level cards/panels
- `rounded-xl`: nested cards, posters, images
- `rounded-lg`: small inner elements only (thumbnails inside a row, tiny logo chips)

---

## Part C — New visual work, in priority order

### C1. Title logo artwork (highest-impact single change)
**Observed**: both lordflix's movie *and* TV show detail pages (confirmed in round 2) render each title's official logo artwork over the backdrop, not a plain text heading. This is the single most consistent "premium/licensed" tell across every streaming UI screenshot we captured, including the hero on the homepage.

**Plan**: fetch the `logos` array from TMDB's `/movie/{id}/images` and `/tv/{id}/images` endpoints (English/no-language-preference, PNG). Render in place of the current text `<h1>` on: home hero (`hero-carousel.tsx`), movie/TV detail page title (`movie-detail.tsx`), and the watch page title (`watch.tsx`) for consistency. Fall back to the current text treatment when a title has no logo art (common for older/obscure titles).

**Implementation note from critic pass**: TMDB logo assets are transparent PNGs with unpredictable, inconsistent aspect ratios — a wide logo and a near-square logo will both come back from the same endpoint. Constrain with a `max-height` + `object-contain` from the start (e.g. `max-h-24 sm:max-h-32 w-auto object-contain`), not as an edge case discovered after the hero layout is already blowing out on a wide logo.

Files: `src/lib/tmdb.ts` (new `movieImages`/`tvImages` methods + type), `hero-carousel.tsx`, `movie-detail.tsx`, `watch.tsx`.

### C2. Card hover treatment
**Observed** (new in round 2 — a static full-page screenshot can't show `:hover`, this required Playwright driving an explicit hover state): lordflix's poster-grid hover is a **centered white circular play icon** over a darkened scrim, with title/year/rating stacked below the icon — not our current bottom-anchored title+button row.

**Plan**: this is a real, different interaction pattern worth adopting for the poster (non-backdrop) card variant specifically — it reads as cleaner and more "single clear action" than our current multi-element bottom-anchored overlay. Backdrop-variant cards (continue-watching, wide cards) can keep the current bottom info treatment since they already show more metadata by design.

**Open implementation question flagged by critic pass**: `movie-card.tsx`'s current hover overlay bundles the Play button *and* the `WatchlistButton` together at the bottom. Swapping to a centered play icon needs an explicit answer for where the watchlist toggle goes — it can't just disappear, that's a real feature (add-to-list straight from the browse grid). Proposed: a small icon button in the card's top-right corner, always-present-on-hover independent of the centered play icon, rather than bundled with it. Confirm this before implementing, don't discover it mid-build.

Files: `movie-card.tsx` (poster variant hover state only).

### C3. Detail page data density
**Correction from critic pass**: `budget`/`revenue`/`original_language` are *not* actually readable today — checked `src/lib/tmdb.ts` directly and the `TmdbMovie`/`TmdbTv` interfaces declare neither field, so `tmdb.movieDetails`/`tvDetails`'s return types don't expose them even though TMDB's raw response includes them for movies. This is type-layer work first, display-layer work second — not the pure display change originally stated. Also: **TMDB does not return budget/revenue for TV at all** — this item is movie-only and needs an explicit `mediaType === "movie"` guard in `movie-detail.tsx`, not applied uniformly to both media types.

- Director credit line: `credits.crew.find(c => c.job === "Director")` — already readable, no type change needed, works for both movie and TV (`created_by` is the TV equivalent if a "showrunner" credit is wanted instead — decide which)
- Compact info panel: add `budget`, `revenue`, `original_language` to the `TmdbMovie` interface in `tmdb.ts` first, then display — **movie only**, guard on `mediaType`
- "Ends at HH:MM" line next to runtime — client-side date math against `runtime`, works for both media types
- Cast section: rework `person-card.tsx` from rectangular photo card to circular avatar + stacked name/role, matching lordflix's tighter density (8 per row instead of 6)
- Trailer: replace the outbound text button with an inline preview card using `img.youtube.com/vi/{key}/hqdefault.jpg` (no extra API call — note this is a YouTube thumbnail, not a TMDB image, so this item has no dependency on C1's TMDB images work despite living in the same section), still linking out to actually play — embedding YouTube's own player would reintroduce the iframe/ads problem the app's player was specifically built to avoid
- Overview: truncate long synopses with a "Read more" expander instead of always rendering in full

### C4. TV detail page — episode layout
**Observed** (new in round 2): lordflix's TV episode browsing uses **horizontal cards** (thumbnail + episode-number badge + duration badge + title, with sort/season controls), not a plain vertical list.

**Plan**: evaluate reworking `episode-list.tsx` from its current vertical-row layout to a horizontal-card grid matching this pattern. Lower priority than C1–C3 — flagging as a real difference worth a decision, not an obvious must-fix, since a vertical list is also a completely standard, legible pattern for episode browsing (e.g. it's what Apple TV's own show pages use for episode lists, per platform-convention knowledge above).

Files: `episode-list.tsx`, `tv-season.tsx`.

### C5. Search empty-state
**Observed** (from first-pass report, restated for completeness): lordflix treats the pre-query search state as a full screen moment — large centered headline, generous whitespace, oversized pill input. CineHome's empty state is a small centered line under a compact bar.

**Plan**: give the `!initialQuery && !initialGenre` branch in `search.tsx` a larger dedicated treatment. Leave the populated-results grid exactly as dense/utilitarian as it already is — that state doesn't need this treatment, only the empty one.

### C6. Mobile bottom navigation
**Observed**: lordflix's mobile home shows a floating pill-shaped icon dock under the hero (home/browse/TV/watchlist/search/settings) — a native-app tab-bar pattern, vs. CineHome's hamburger-to-drawer.

**Plan**: replace the hamburger drawer with a fixed bottom icon bar on mobile viewports. CineHome is already a configured PWA (manifest + service worker + install prompt already shipped) — this is the missing piece that would make it feel like the installed app it technically already is, not a new system bolted on.

**Gaps flagged by critic pass — both need to be in scope from the start, not discovered mid-implementation**:
1. **iOS safe area**: the new bar needs `padding-bottom: env(safe-area-inset-bottom)` (or Tailwind's `pb-safe` if configured) so it doesn't sit under the iOS home indicator on notched devices.
2. **Content clearance**: every mobile page currently assumes the viewport is unobstructed at the bottom. Adding a fixed bottom bar means every mobile-visible page needs bottom padding added (e.g. `pb-20` on the page/layout wrapper) or the new bar will sit on top of existing page content rather than beside it. This is a cross-cutting change, not contained to `navbar.tsx` alone — likely belongs in `src/app/(main)/layout.tsx` so it's applied once rather than per-page.

Files: `navbar.tsx` (mobile branch), `src/app/(main)/layout.tsx` (bottom clearance), desktop nav unchanged.

---

## Suggested sequencing

1. **Part A** (bug fixes) — small, mechanical, low-risk, clears the ground.
2. **C1** (title logos) — highest visual impact, touches the most-seen surfaces (home hero, every detail page).
3. **C3** (detail page data density) — cheap, all data already in hand, same file as C1 so worth batching.
4. **C2** (card hover) — contained to one component.
5. **C6** (mobile nav) — the one genuinely structural change; do it once the token/motion foundation from Part A/B is solid so the new component starts consistent rather than needing its own follow-up fix pass.
6. **C5** (search empty state) — contained, independent, can slot in anywhere.
7. **C4** (episode layout) — lowest priority, explicitly flagged as "worth a decision" rather than a clear fix; revisit after everything else lands.

## Verification per phase

- `bunx tsc --noEmit` and `bun run lint` clean after every phase, not just at the end.
- Full `bun run build` before deploying.
- Re-screenshot the affected CineHome pages after each phase and compare against this plan's stated intent — same method as the research passes (Playwright, live deployment), so we're checking against reality, not assuming the diff did what it was supposed to.
- Deploy to hussyserver only after a phase's own verification passes; don't batch multiple phases into one untested deploy.

## Open questions (need a decision before implementing, not blocking the plan itself)

- **C4** (episode layout): adopt horizontal cards, keep the current vertical list, or treat as a "later" item? A vertical list isn't wrong, just a different valid convention.
- **A7** (spacing rule): confirm the wide/narrow split is the right rule, vs. picking one number for the whole app.
- **C2**: confirm backdrop-variant cards (continue-watching, wide rows) should keep their current bottom-anchored info treatment rather than also switching to the centered-icon pattern.
