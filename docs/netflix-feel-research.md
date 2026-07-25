# Absolute Cinema — Netflix-like product research

**Date:** 2026-07-17  
**Scope:** Household multi-provider HLS (CineHome), not cloning Netflix CDN.

## Thesis

Netflix feel = **instant catalog + silent recovery + clear chrome**.  
Multi-provider feel = **honest Server list + full Quality ladder on the live source**.  
Never: hung “searching…” spinner or a fake single quality rung.

## What Netflix actually does

- Quality is mostly **account data caps** (Auto / Low / Medium / High), not mid-play 480/720/1080 menus.
- ABR is **client-side** from a trusted multi-bitrate ladder on Open Connect.
- Users still expect **YouTube-style discrete quality** on self-hosted/scraper apps.

**Product blend for Absolute Cinema:** Netflix immersion (browse, resume, binge) + YouTube quality control + Stremio/Cineby multi-server honesty.

## Non-negotiables

| Area | Rule |
|------|------|
| Quality | Auto first; list all rungs of **active** source; mid-play switch without full reload |
| Server | Separate from Quality; badges + failover; keep seek position |
| Reliability | First frame fast; recover → next server → hard error with Retry |
| Loading | Clear hunting when playable; bounded wall; soft-kept ≠ healthy count |
| Honesty | No fake ladders; single-rung → “switch Servers” |

## Absolute Cinema status

| Layer | Status |
|-------|--------|
| Browse (hero, rails, CW, detail) | Strong |
| Server vs Quality dock | Strong |
| Full quality ladder UI | Shipped (when master multi-rung) |
| Hunting / partial hang | Hardened (partial clear @2, 18s UI wall, buffer chip) |
| Multi-rung default | Prefer Luna-class masters |
| First-frame wall failover | Shipped (~22s after discovery) |
| Fake Netflix CDN / 4K always | **Non-goal** |

## Explicit non-goals

- Pretend Open Connect global edge
- Hide multi-server because Netflix doesn’t show CDNs
- Invent multi-rung menus from unrelated servers
- Infinite “searching for more” theater
- Always pin 4K first on residential proxy

## Competitive notes

| Product | Lesson |
|---------|--------|
| Netflix | Immersion, resume, binge |
| YouTube / hls.js UIs | Auto + discrete rungs |
| Stremio | Source list *is* resolution honesty |
| Cineby | Auto-switch servers + custom player |
| Plex/Jellyfin | Library polish, not multi-scraper |

## Implementation map (2026-07-17)

See deploy history: quality ladder, discovery walls, roster hygiene, ironwall referers, watchlist filter fix, double-toast fix, Netflix-style Settings quality labels, first-frame failover.
