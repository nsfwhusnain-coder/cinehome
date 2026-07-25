# FMHY Stream Site Grading → CineHome Source Map

**Date:** 2026-07-19  
**Filter:** Score **≥ 15/18** only (user rule)  
**Source:** FMHY Stream Site Grading wiki (snapshot from user paste; backup `https://fmhy-grading.pages.dev/`)  
**Goal:** Turn “good sites” into **extractable stream backends** for Absolute Cinema — not clone their UIs.

**Legal:** Household self-host research only. Sites are third-party; streams are not hosted by CineHome.

---

## Core principle (do not get this wrong)

FMHY grades **frontends** (UI + player UX + ads).  
CineHome needs **resolvers** (m3u8/mp4 + headers).

| FMHY site type | What it usually is | CineHome action |
|----------------|--------------------|-----------------|
| **Stream Aggregator 18/18** | TMDB shell + multi-embed/API fan-out + custom player | Steal **provider list**, not the site |
| **Multi-Server 15–18** | Own catalog + multiple hosters/embeds | Probe for unique hosts; PW or API |
| **Dedicated-Server 15+** | Single CDN / self-hosted player | Harder extract; lower priority unless pure HTTP |

**Do not** Playwright 63 full sites. That burns the pool and duplicates work.  
**Do** resolve the shared **embed/API layer** those sites already depend on.

---

## Score ≥ 15 roster (parsed from grading paste)

**n = 63 sites** (all ≥15/18).

### 18/18 — Stream Aggregators (primary “good” tier)

| Site | Notes for CineHome |
|------|-------------------|
| Cineby | **Reference architecture** — `vidnest` iframe / `backend.cineby.at` + Workers; same family as Vidking/Videasy paths |
| P-Stream Forks | movie-web lineage → `@providers` scrapers; ideas for pure-HTTP providers |
| Rive | Aggregator shell; same embed ecosystem |
| Flixer / Hexa | Aggregator; Hexa often = multi-provider extractors |
| PopcornMovies | Multi-server auto-switch |
| 67Movies | ArtPlayer hybrid; multi-source |
| MeowTV / FlickyStream | Aggregator |
| Coreflix | Aggregator |
| bCine | Non-embed sources + embeds |
| ShuttleTV | Aggregator |
| TouStream | Aggregator; low popup |
| Vyla | Aggregator |
| ArrowTV / Cinezo | + ES/IT dubs |
| GOATED | Aggregator |
| dulo.tv | Aggregator |
| MovieBite | Aggregator |
| Overlook | Auto-check sources |
| Stigstream | Aggregator |
| Shiopa | Aggregator |
| Cinetaro | Aggregator |
| Moovie | Aggregator |
| Cinevibe | Vidstack custom player |
| Cinegram | Notes **vidfast** custom player |
| Willow | Aggregator |
| Chillflix | Aggregator |
| cinrift | Aggregator |
| Movie Night | Aggregator |
| Movish | Aggregator |

### 18/18 — Multi-Server (more likely unique hosters)

| Site | Priority |
|------|----------|
| 1Shows / 1Flex | Probe |
| Anixtv | **Anime** lane candidate |
| AuroraScreen | Probe |
| CinemaOS | Live 200 from hussyserver — **probe extract path** |
| PrimeShows / NetShows | Probe |
| ZetMoon | Probe |

### 17/18

| Site | Section | Note |
|------|---------|------|
| All You Can Watch | Aggregator | |
| CineBolt | Aggregator | |
| **CinePro** | Aggregator | **Already co-located** (`cinepro-core`) — keep enabling |
| FilmU | Multi | |
| FireFlix | Multi | |
| Flixtrz | Aggregator | |
| FRAME / SanuFlix | Aggregator | |
| **HydraHD** | Multi | Live 200 from server — **high value multi-hoster** |
| Nextbox | Aggregator | |
| OpStream | Aggregator | |
| Streamo | Aggregator | |
| ZXCSTREAM | Aggregator | |

### 16/18

| Site | Section | Note |
|------|---------|------|
| BingeBang | Aggregator | |
| Cinema.BZ | Aggregator | |
| Nelvix | Aggregator | |
| NomorFlix | Aggregator | |
| **SmashyStream** | Aggregator | Player TLS fail from server (2026-07-19) — **skip until healthy** |
| Streamr | Multi | |
| VidBox | Multi | |

### 15/18

| Site | Section | Note |
|------|---------|------|
| 321Movies | Multi | |
| Bingr | Dedicated | |
| CineWave | Multi | |
| EE3 | Dedicated | |
| FilmCave | Multi | |
| Flixzy | Multi | |
| Netplay | Aggregator | |
| Screenscape | Aggregator | |
| XYRA | Aggregator | |
| Youflex | Multi | |

*Sites &lt; 15/18 intentionally excluded per user rule.*

---

## Shared backend layer (what aggregators actually use)

Measured **from hussyserver cinehome** 2026-07-19 + prior CineHome research.

### Already in CineHome (keep / invest)

| Backend | CineHome path | FMHY sites that rely on same class | Status |
|---------|---------------|-------------------------------------|--------|
| **Vixsrc** | API Luna | Most aggregators as one server | Live |
| **VidLink** | API Phoenix | Common | Live |
| **CinePro OMSS** | Fast/full race | FMHY lists **CinePro 17/18** | Live (48h eval) |
| **Vidking** | PW Solstice | Cineby family / best CDN class | Live primary PW |
| **VidNest** | PW Nest | **Cineby** CSP / iframe | Live primary PW |
| **VidFast** | PW Flux | **Cinegram** player note | Live primary PW |
| **VidSrc.to / .me** | PW | Universal | Live 2-wave |
| **2embed / multiembed** | PW secondary | Universal | Live secondary wave |
| Videasy / LordFlix | API enc-dec | Common on aggregators | Often empty; circuit opens |
| NoTorrent | API | Occasional | Poison php wrappers demoted |

### Reachable but **not** yet first-class CineHome providers

| Backend | Probe | Integration shape | Priority |
|---------|-------|--------------------|----------|
| **HydraHD** (`hydrahd.com` / `.ru`) | HTTP 200 | **WRAPPER_ONLY** — iframe pack of Vixsrc/Vidking/VidFast/… already covered; **skip implement** | **Skip** |
| **CinemaOS** (`cinemaos.tech`) | HTTP 200 | **Implemented** pure-HTTP `providers/cinemaos.ts` → `/api/cinemaosv2` EN-prefer MP4; iframe catalog not scraped | **Live** |
| **Flixer** (`flixer.su`) | HTTP 200 | Aggregator; reverse its source API if public | **P2** |
| **Cineby** (`cineby.at`) | HTTP 200 | Study `backend.cineby.at` patterns; **do not** depend on their private API long-term | Architecture ref only |

### Dead / blocked from hussyserver (skip)

| Backend | Result |
|---------|--------|
| SmashyStream player | TLS altname invalid / connect fail |
| hexa.watch | Connect fail |
| rivestream.org / rive.movie | Connect fail |
| Myth JSON (vidsrc page-1.json, sflix/himovies apis) | Dead (Phase 0) |

---

## Mapping: “use FMHY good sites” → concrete CineHome work

### A. Do not scrape (UI-only value)

All **Stream Aggregators** at 18/18 (Cineby, Rive, 67Movies, …) → **feature parity targets for UX**, not new scrape targets:

- Auto source switch ← already have first-frame wall + multi-source dock  
- Episode auto-next ← player/watch page feature (not scraper)  
- Watchlist/history/sync ← already product scope  
- Custom player ← already hls.js  

### B. Do extract (stream value)

| Priority | Action | Why |
|----------|--------|-----|
| **P0 keep** | CinePro + Vixsrc + VidLink + Vidking/VidNest/VidFast PW | Same stack FMHY 18/18 sites use |
| **P1 done** | CinemaOS `/api/cinemaosv2` → `providers/cinemaos.ts` (chip **Cinema**) | Progressive MP4 via worker proxies; EN first |
| **P1 skip** | HydraHD | WRAPPER_ONLY of existing providers — do not add |
| **P2** | movie-web / P-Stream `@providers` harvest | Port **working** scrapers server-side only |
| **P2** | Anixtv / anime-specific hosts | Anime lane without Consumet |
| **P3 skip** | Smashy, dead hexa/rive, &lt;15 scores | Evidence or score rule |

### C. Overlap cut (avoid double work)

If CinePro already returns **VidNest / VixSrc / Fshare / Icefy**, do not also burn PW on the same identity for that title (Luna de-dupe already live for CinePro VixSrc).

---

## Recommended “FMHY-aligned” provider tiers for CineHome

```
Tier S (always)     Vixsrc · VidLink · CinePro (eval→permanent when green)
Tier A (PW wave 1)  Vidking · VidNest · VidFast · 1× VidSrc   [matches top aggregators]
Tier B (PW wave 2)  2embed · multiembed · 2nd VidSrc mirror
Tier C (API)         CinemaOS (cinemaosv2 MP4) · selected @providers scrapers
Tier C skip          HydraHD (wrapper-only)
Tier D (optional)   Real-Debrid/Torrentio (quality, not FMHY UI score)
Tier X (disabled)   Smashy · myth JSON APIs · Videasy/LordFlix when empty rate high
```

---

## Acceptance for “added FMHY sources”

A FMHY site is **successfully used** when CineHome can play streams from **its underlying backends**, not when we iframe the site.

Success check per new backend:

1. Resolves TMDB/IMDB → ≥1 m3u8/mp4 from hussyserver  
2. Plays through `/api/hls` with correct Referer  
3. Not poison-default  
4. Kill-switch + circuit  
5. Documented in this file + `alternative-sources.md`

---

## Next implementation slice (when executing)

1. ~~**CinemaOS**~~ — done (`providers/cinemaos.ts`, circuit `cinemaos`, kill `PROVIDER_CINEMAOS=0`).  
2. ~~**HydraHD**~~ — probed WRAPPER_ONLY; **do not implement** (see `.claude/handoffs/hydrahd-cinemaos-probe.md`).  
3. Optional: port 1–2 healthy scrapers from P-Stream/`@providers` if pure HTTP.  
4. Do **not** add all 63 as Playwright targets.

---

## Appendix — full ≥15 name list (quick)

18: 1Shows/1Flex, 67Movies, Anixtv, ArrowTV/Cinezo, AuroraScreen, bCine, Chillflix, Cineby, Cinegram, CinemaOS, Cinetaro, Cinevibe, cinrift, Coreflix, dulo.tv, Flixer/Hexa, GOATED, MeowTV/FlickyStream, Moovie, Movie Night, MovieBite, Movish, Overlook, P-Stream Forks, PopcornMovies, PrimeShows/NetShows, Rive, Shiopa, ShuttleTV, Stigstream, TouStream, Vyla, Willow, ZetMoon  

17: All You Can Watch, CineBolt, CinePro, FilmU, FireFlix, Flixtrz, FRAME/SanuFlix, HydraHD, Nextbox, OpStream, Streamo, ZXCSTREAM  

16: BingeBang, Cinema.BZ, Nelvix, NomorFlix, SmashyStream, Streamr, VidBox  

15: 321Movies, Bingr, CineWave, EE3, FilmCave, Flixzy, Netplay, Screenscape, XYRA, Youflex  
