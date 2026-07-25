# Lordflix Parity Architecture — CineHome

**Date:** 2026-07-09  
**Goal:** Same *product model* as Lordflix (not a binary clone of proprietary code).

## What Lordflix actually is

| Layer | Lordflix (public evidence) | CineHome parity |
|-------|---------------------------|-----------------|
| Shell | Custom dark SPA (SvelteKit) | Next.js Netflix shell |
| Player UI | Custom chrome | Custom `VideoPlayer` + dock |
| Engine | **hls.js ~1.6.x** | **hls.js ~1.6.x** |
| Resolve | Multi-provider backend | Scraper + **CinePro OMSS** |
| Media plane | Edge / proxy near CDN | Home `/api/hls` + **CinePro `/v1/proxy`** |
| Fallback | Multiple servers | CineHome sources + **Embed iframes** |

We do **not** copy Lordflix branding, closed assets, or reverse-engineered private APIs. We copy the **architecture**.

## Topology (hussyserver)

```
Browser (LAN/Tailscale)
   │  sign-in
   ▼
CineHome :4445  (Next + stream-scraper)
   │  fast resolve
   ├─► CinePro :3000 (Docker embedin_default) ──► 14 providers + /v1/proxy
   ├─► Vixsrc / VidLink / NoTorrent / Playwright embeds
   ▼
Player
   ├─ Mode CineHome: hls.js → /api/hls → (CinePro proxy URL | CDN)
   └─ Mode Embed: iframe → vidking / vidsrc / embedin :4444
```

## Why this feels closer to Lordflix

1. **Many providers in parallel** (CinePro), not one slow Luna path.  
2. **Proxy lives with the extractor** (CinePro), not inventing CF Worker for Vixsrc (403).  
3. **Embed mode** for “just play” when custom path is weak (Cineby DNA).  
4. **Same engine family** (hls.js) with immersive full-bleed watch UI.

## Env

- `CINEPRO_URL=http://cinepro-core:3000`
- `WORKER_PROXY_ENABLED=0` (default; CF edge often 403s embed CDNs)
- `NEXT_PUBLIC_EMBEDIN_URL` for LAN EmbedIn chip

## Non-goals

- Cloning Lordflix UI pixel-perfect  
- Client-side scrape (movie-web model) for household auth product  
- Re-enabling Worker without per-CDN verification  
