# CineHome Design Tokens (v3)

Source of truth for spacing, type, motion, radius, and CTAs. Implementation should match these numbers; do not invent ad-hoc values in components.

## Spacing rhythm

- **Tight** (icon-to-label, badge padding): `gap-1.5` / `gap-2` (6–8px)
- **Component-internal** (card padding, row gaps): `gap-3` / `gap-4` (12–16px)
- **Narrow-page section rhythm** (settings, login): `space-y-6` (24px)
- **Wide-page section rhythm** (home, detail, search, watchlist, continue-watching): `mt-10`–`mt-12` (40–48px)

## Type

- Hero title: `text-5xl` → `text-7xl`, `font-display`
- Page H1: `text-2xl` → `text-3xl`, `font-display` (including empty/auth alternate states)
- Section heading: `text-xl`, `font-display`
- Body: `text-sm` / `text-base`, default sans
- Meta/micro: `text-xs`, default sans; `font-mono tabular-nums` for numbers

## Motion

Shared module: `src/lib/motion.ts`

| Token | Value | Use (matches shipped call sites) |
|---|---|---|
| `EASE_OUT_EXPO` | `[0.16, 1, 0.3, 1]` | Content fade-ins, page transitions (250–500ms) |
| `transitionFast` | 0.25s + expo | Card/item staggers |
| `transitionContent` | 0.3s + expo | Section reveals; `page-transition` route wrapper |
| `transitionView` | 0.35s + expo | Row/section mounts; settings shell entry |
| `transitionEnter` | 0.4s + expo | Auth (login) entry only |
| `transitionHero` | 0.5s + expo | Hero content crossfade |

Durations intentionally preserve pre-v3 timings at each call site (no visual regression). Prefer the token that matches the surface’s historical duration over a strict semantic ladder.

Direct-manipulation feedback (hover/tap): 150–250ms; springs optional later. Ambient/Ken Burns: `linear`, leave as-is.

## Radius

- `rounded-full` — pills, buttons, avatars
- `rounded-2xl` — page-level cards/panels, settings rows
- `rounded-xl` — nested cards, posters, images
- `rounded-lg` — small inner elements only (thumbnails inside a row, tiny chips)

## CTA matrix (KD20)

Documented for later component PRs — do not redesign hubs/nav/cards in this foundation PR.

| Surface | Treatment |
|---|---|
| **Hero / detail primary Play** | Light/white pill |
| **Secondary actions** | Crimson primary / icon circles |
| **Card hover play** | White circular play over darkened scrim |

Crimson remains the app accent for secondary CTAs, focus rings, and non-hero actions. Hero/detail Play is intentionally inverted (light pill) for streaming-UI parity.
