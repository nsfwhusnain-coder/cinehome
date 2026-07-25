# Why Lordflix / Cineby Feel Smooth — and What CineHome Does Differently

Date: 2026-07-09  
Goal: Full-system comparison (not a single bugfix).

---

## Executive answer

Lordflix and Cineby do **not** ship every video segment through a **home laptop** with Docker + Playwright + Next.js.

Their stack separates:

1. **Catalog UI** (TMDB shell) — cheap
2. **Source resolution** (datacenter backend / shared extractors)
3. **Media delivery** (CDN direct **or** Cloudflare/Vercel **edge CORS proxy**)

CineHome merges all three onto **hussyserver (residential / laptop, Tailscale, co-resident with Plex/*arr)** and forces:

```
Browser → home Next.js → CDN → home → Browser
```

for **every** `.ts` segment. That architecture cannot match them until media delivery leaves the home box (or uses iframe embeds that already solved delivery).

---

## Aspect-by-aspect comparison

### 1. Hosting / edge

| Aspect | Lordflix | Cineby (cineby.at / cineby.tech) | CineHome |
|--------|----------|----------------------------------|----------|
| Front door | **Cloudflare** anycast | **Cloudflare** + ddos-guard / LiteSpeed | Home IP / Tailscale |
| Origin | Datacenter-class (CF-proxied) | `backend.cineby.at` + Workers | ASUS laptop Ubuntu |
| Segment path | Client→CDN or Client→CF edge | Client→CDN via **Workers CORS proxy** | Client→home→CDN→home |
| RTT to first byte | Edge near user | Edge near user | Home uplink + server load |

**Evidence:**
- lordflix.org: `server: cloudflare`
- cineby.at: Next.js + `simple-proxy.cineby.at`, `*.cineby.workers.dev`
- cineby.tech CSP: `frame-src https://vidnest.fun https://embed.st`, `media-src https:`

### 2. Who plays the video

| Model | Sites | How it works |
|-------|-------|--------------|
| **A. Custom player + cloud proxy** | Lordflix-class | Resolve m3u8 on backend; segments via edge proxy or direct CORS-friendly CDN |
| **B. Iframe embed player** | Cineby.tech | Shell UI; **iframe** `vidnest.fun` / `embed.st` owns extraction + player |
| **C. Custom player + home proxy** | **CineHome** | Full hls.js + `/api/hls` on laptop |

Cineby.tech Watch chunk literally centers on **vidnest.fun iframe**, not a home-built segment proxy.

### 3. Source resolution

| | Them | Us |
|--|------|-----|
| Parallel API providers | Yes (Videasy multi-server, VidLink, Vixsrc, Lordflix 9-server via enc-dec, etc.) | Partial; many dead (enc-dec) |
| Playwright | Rare / last resort on **their** infra | Heavy on same box as playback |
| Ranking | Production traffic + health | Name heuristics + late probes |
| Backend | Always-on shared API (`backend.cineby.at/v1`) | `stream-scraper` inside same container |

### 4. CORS / Referer problem (the hard technical gap)

Embed CDNs require **Referer: vidking.net / vixsrc.to**.

Browsers **forbid** setting `Referer` from page JS. So either:

1. **Iframe** the embed (their page has correct Referer) — Cineby model  
2. **Proxy** that adds Referer — needs **fast** proxy (datacenter/Worker), not residential double-hop  
3. **Browser extension** that injects headers  

CineHome chose (2) on a laptop → correct auth, wrong network path.

### 5. CORS proxy pattern (Cineby — measured in JS)

From `cineby.at` `_app` bundle:

```
backend.cineby.at/v1          # API + auth + sources
simple-proxy.cineby.at/?destination=
cors-smashystream.cineby.workers.dev/?destination=
proxy-opensubtitles.cineby.workers.dev/?destination=
corsproxy.io/?...
justchill.weathershare...     # more CORS workers
```

**Meaning:** Cineby’s “server that works really well” is largely **Cloudflare Workers + a real backend host**, not a home theater PC.

### 6. Player UX

| | Them | Us |
|--|------|-----|
| Player | Embed player or tuned hls.js on edge | Custom hls.js through home proxy |
| Server switch | First-class, many servers | Few working sources |
| Buffering | Segments near user | Segments detour home |

### 7. Scale / load

| | Them | Us |
|--|------|-----|
| Concurrent users | Shared infra amortized | One box for family + *arr + Plex + scrape |
| Disk | Separate from media library | 76% full, shared |

---

## What we are doing wrong (checklist)

1. **Wrong place for media plane** — home server as segment proxy  
2. **Wrong player strategy** — reinventing custom HLS instead of proven embed **or** cloud proxy  
3. **Wrong success metric** — “scrape returns URL” ≠ “smooth play”  
4. **Wrong co-location** — Playwright + segment proxy + Plex/*arr on one laptop  
5. **Incomplete source layer** — dead enc-dec paths, slow Luna path still in system  
6. **No edge network** — no CF Worker / VPS near users for Tailscale/remote  
7. **Comparing UI clones to infra clones** — we matched Lordflix *look*, not *network*

---

## What we need to change (full list, not one knobs)

### Layer 0 — Product decision (pick one primary media model)

**Option 1 — Cineby.tech model: Embed shell (fastest path to “works like them”)**  
- CineHome UI stays  
- Watch page = quality iframe hosts (vidnest / embed.su / similar) with server picker  
- Optional: hide iframe chrome with CSS where possible  
- Home proxy for video **optional / off**

**Option 2 — Lordflix model: Custom player + cloud media plane**  
- Keep hls.js  
- Move **only** resolve + segment proxy to:
  - Cloudflare Worker (CORS + headers + optional cache), **or**
  - Small VPS (Hetzner/DO $5) running TMDB-Embed-API / CinePro-style proxy  
- Home machine serves **UI only** (or even static frontend)

**Option 3 — Hybrid**  
- Try custom player through **Worker proxy** first  
- Fallback button “Open embed player” if custom fails  

### Layer 1 — Source resolution (shared with both models)

- Backend API fan-out: Videasy multi-server, VidLink, Vixsrc, NoTorrent, etc.  
- Prefer APIs over Playwright  
- Latency probe rank (already started)  
- Kill dead providers by env  
- Do **not** depend on home Playwright for first play  

### Layer 2 — Delivery

- **Never** default long movies through residential double-hop at 1080p  
- Worker/VPS: stream-through + segment cache  
- Or iframe and let embed host deliver  

### Layer 3 — Player

- If custom: cap quality, start low, auto-upgrade source after probe  
- If embed: focus on chrome (server list, fullscreen, next episode) around iframe  

### Layer 4 — Ops

- Separate “media plane” from “library plane” (*arr/Plex can stay; CineHome media leaves home)  
- Disk budget for scrapes only if we keep local proxy  

---

## Recommended path for “like Lordflix and Cineby”

Given you rejected Jellyfin/Plex and want scrape-style:

### Phase 1 (1–2 days) — Match Cineby delivery model
1. Add **Embed Player mode** as primary watch path (vidnest/embed-style iframe + server list)  
2. Keep custom player as secondary “Advanced”  
3. Stop requiring home proxy for default play  

### Phase 2 (2–4 days) — Match Lordflix custom player  
1. Deploy `simple-proxy` style **Cloudflare Worker** (or $5 VPS) that:
   - Adds Referer/Origin  
   - Streams body  
   - Optional cache  
2. Point CineHome rewritten m3u8 segments at Worker URLs, not `/api/hls` on home  
3. Home only does scrape resolve (or also move resolve to Worker/VPS)  

### Phase 3 — Source quality  
1. Wire Videasy multi-server list properly  
2. Probe-rank on resolve host (already partially done — run on same host as proxy)  
3. Drop Playwright from critical path  

---

## One-line truth

**They work because media traffic hits professional edge networks and/or third-party embed players.  
We fail because we force media through a home theater PC.**

UI can look like Lordflix tomorrow.  
Playback can feel like Lordflix only after the **media path** matches theirs.
