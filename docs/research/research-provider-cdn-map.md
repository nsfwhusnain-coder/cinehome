# CineHome Provider & CDN Research Map

**Date:** 2026-07-09  
**Scope:** Stream extraction (prefer no Playwright), CDN characteristics, multiLang EN, alternatives  
**Target deployment:** EU/US home server → household clients over Tailscale (HLS proxy hop on home server)

> Ranking optimizes **expected play smoothness** (resolve TTFF + segment throughput + mid-play stability), not embed-site popularity.  
> Evidence = CineHome `mini-services/stream-scraper` + live DNS/HTTP probes + public docs (2025–2026).

---

## Executive ranking (play smoothness, EU/US home server + Tailscale)

| Rank | CineHome label | Provider | Extract mode | Smoothness score (1–10) | Why |
|------|----------------|----------|--------------|-------------------------|-----|
| **1** | **Luna** | **Vixsrc** | HTTP API + HTML token scrape (**no PW**) | **9.0** | Fastest resolve, signed HLS master, Cloudflare edge, EN default, FHD flag |
| **2** | **Phoenix** | **VidLink** | Encrypted REST API (**no PW**) | **8.5** | CloudFront + CF media CDNs; `multiLang=1`; ABR HLS; solid EU/US PoPs |
| **3** | **Solstice** | **Vidking** | Embed Playwright capture | **7.0** | Strong CF media CDN once resolved; **resolve is heavy** (18s wait, browser pool) |
| **4** | **Nova** | **Embed.su** (ex-vidsrc.pro) | Embed Playwright (API reverse possible) | **6.0** | Hetzner DE origin (good EU, weaker US); slower TTFB; no first-class public stream API |
| **5** | **Pulse** | **NoTorrent** | Stremio JSON API (**no PW**) | **5.0** | EN + multi-lang coverage; **CDN quality lottery** (hostinger / bare IP / workers) |

**Recommended default order for CineHome (matches current code priority):**  
`Vixsrc → Vidking (quality) → VidLink (multiLang) → Embed.su → NoTorrent`

**Recommended order if optimizing pure smoothness + low host CPU (minimize Playwright):**  
`Vixsrc → VidLink → NoTorrent (best EN HLS only) → Vidking/Embed.su only to fill slots`

---

## Architecture note: Tailscale path

```
Client (EU/US home LAN or remote Tailscale)
  → Home server :4445  (Next app + HLS proxy)
    → Scraper :3030    (resolve once → m3u8 URL + session headers)
    → Upstream CDN     (segments proxied by home server)
```

Implications:
- **Client ↔ home server** smoothness is Tailscale/LAN-bound (usually fine).
- **Home server ↔ CDN** is the bottleneck for 1080p/4K ABR.
- Prefer providers whose **media CDN has EU/US edges** (CloudFront, Cloudflare, major CDNs).
- Avoid origins that pin to **single-region VPS / bare IP / free-tier cold hosts**.
- Playwright extract burns **CPU/RAM on the home server** before first frame — hurts concurrent household use even if CDN is fine.

---

## CineHome known providers (deep dive)

### 1. Vixsrc — Luna (default)

| Field | Detail |
|-------|--------|
| **Site** | `https://vixsrc.to` |
| **Friendly name** | Luna |
| **How to get stream URL** | **API-first, no Playwright** |
| **Resolve path** | 1) `GET /api/movie/{tmdb}` or `/api/tv/{tmdb}/{s}/{e}` → `{src}` 2) `GET vixsrc.to{src}` HTML 3) Regex `token`, `expires`, playlist `url` 4) Master: `{playlist}?token=…&expires=…&h=1` |
| **Code** | `mini-services/stream-scraper/providers/vixsrc.ts` |
| **CDN** | Site on **Cloudflare**. Playlist host varies; proxy allowlists `vixsrc.to`. Signed URLs with `expires`. |
| **Format** | HLS master (variant ladder; quality parsed from `#EXT-X-STREAM-INF`) |
| **multiLang EN** | **Yes.** API sample returns `lang=en` by default; embed supports `?lang=` (docs: audio preference, e.g. `lang=it`). English is default for US/EN catalog. |
| **Probe (2026-07-09)** | API `GET /api/movie/786892` → 200, ~0.4s TTFB, `canPlayFHD=1`, `lang=en` |
| **Pros** | Fastest cold resolve; no browser; FHD-capable; stable extract pattern; already Luna-first + `fast=1` |
| **Cons** | Token expiry short-ish (must re-resolve); CF bot walls occasionally on raw embed HTML; coverage slightly behind mega multi-source aggregators |
| **Faster same-coverage alts** | None strictly faster. Closest: **VidLink** (more sources/anime, slightly heavier crypto). |
| **Smoothness (EU/US)** | **Best.** Resolve <1s; HLS ABR; CF front door. |

Embed docs (public):
- Movie: `https://vixsrc.to/movie/{tmdb|imdb}`
- TV: `https://vixsrc.to/tv/{id}/{season}/{episode}`
- Catalog: `https://vixsrc.to/api/list/{movie|tv|episode}?lang=it`

---

### 2. VidLink — Phoenix

| Field | Detail |
|-------|--------|
| **Site** | `https://vidlink.pro` |
| **Friendly name** | Phoenix |
| **How to get stream URL** | **Encrypted REST API, no Playwright** |
| **Resolve path** | 1) XSalsa20-Poly1305 (tweetnacl) encrypt `tmdbId + timestamp` with fixed key 2) `GET /api/b/movie/{token}?multiLang=1` or `/api/b/tv/{token}/{s}/{e}?multiLang=1` 3) Walk JSON for `.m3u8` / `.mpd` / `.mp4` 4) Verify segment >500B |
| **Code** | `mini-services/stream-scraper/vidlink-api.ts` |
| **CDN hosts (CineHome)** | `storm.vodvidl.site` (**Cloudflare**), `sacdn/bcdn/cacdn.hakunaymatata.com` (**CloudFront** → AWS, multi-PoP) |
| **Referer** | Must send `https://vidlink.pro/` (proxy overrides in `hls-proxy.ts`) |
| **Format** | Prefer HLS; fallback DASH/MP4; HEVC penalized |
| **multiLang EN** | **Yes — first-class.** CineHome always requests `multiLang=1`. Design doc Phase A inventory title is “VidLink multiLang”. Multiple audio/subtitle `#EXT-X-MEDIA` tracks common. |
| **Pros** | No PW; multi-audio; CloudFront EU/US edges; anime + movie + TV; rich source tree |
| **Cons** | Token key can rotate (break extract); some titles DASH/HEVC only; verify loop adds latency; WASM-era scrapers obsolete — pure nacl works (also mirrored by public `Vidlink.pro-Decryptor` Python projects) |
| **Faster same-coverage alts** | **Vixsrc** for single best EN HLS when present. **Videasy** multi-server for coverage fill (enc-dec dependent). |
| **Smoothness (EU/US)** | **Excellent** when HLS + CloudFront; mid-play 403s if session/referer dropped. |

Public embed:
- `https://vidlink.pro/movie/{tmdbId}`
- `https://vidlink.pro/tv/{tmdbId}/{s}/{e}`
- Anime: `https://vidlink.pro/anime/{malId}/{ep}/{sub|dub}`

---

### 3. Vidking — Solstice

| Field | Detail |
|-------|--------|
| **Site** | `https://www.vidking.net` |
| **Friendly name** | Solstice |
| **How to get stream URL** | **Embed scrape (Playwright)** — no documented public stream JSON API |
| **Resolve path** | Open `https://www.vidking.net/embed/movie/{tmdb}?autoPlay=true` (or `/embed/tv/...`) → capture network `.m3u8`/`.mp4` → verify HLS |
| **Code** | `stream-scraper/index.ts` `buildSourceUrls` + `tryScrapeUrl` (wait ~18s for video) |
| **CDN hosts** | `moon.ironbubble.site`, `infantinostreet.site`, `ironbubble.site`, `moon.ironwallnet.net` — **Cloudflare** |
| **Referer** | Embed URL / `https://www.vidking.net/` |
| **Format** | HLS preferred; ironbubble path patterns |
| **multiLang EN** | **English primary** (Western catalog). No public multiLang toggle found; typically single default audio (EN when available). Subtitles via player UI, not API. |
| **Probe** | Site TTFB ~45ms (CF cached); media hosts CF |
| **Pros** | High quality CDN once playing; good coverage; simple embed API for iframe sites |
| **Cons** | **Playwright required today** (pool of 2 Chromiums) → slow TTFF, RAM, serial contention; no stable reverse-engineered API found in-tree |
| **Faster same-coverage alts** | Prefer **Vixsrc/VidLink API** first; keep Vidking as quality fallback. Research candidate: reverse player JS for playlist endpoint (not yet in CineHome). |
| **Smoothness (EU/US)** | **Playback: good (CF). Start: poor (PW).** Worst for concurrent resolve on a laptop server. |

Public embed:
- Movie: `https://www.vidking.net/embed/movie/{tmdbId}`
- TV: `https://www.vidking.net/embed/tv/{tmdbId}/{season}/{episode}`

---

### 4. Embed.su — Nova (vidsrc.pro successor)

| Field | Detail |
|-------|--------|
| **Site** | `https://embed.su` |
| **Friendly name** | Nova |
| **How to get stream URL** | **Embed scrape (Playwright)** in CineHome. Historical reverse: hash-based server list → stream URL (`heyitswit/vidsrc-bypass`, archived Oct 2024). |
| **Resolve path (current)** | `https://embed.su/embed/movie/{tmdb}` or `/embed/tv/{tmdb}/{s}/{e}` → PW capture m3u8 (~25s wait) |
| **CDN** | Site origin **Hetzner DE** (`157.90.33.x`, Angie). Media CDN not fixed in CineHome allowlist (varies per title/server). |
| **vidsrc.pro status** | **`vidsrc.pro` → 301 → `https://embed.su/`** (confirmed 2026-07-09). Treat as rebrand/merge. |
| **multiLang EN** | English available via multi-server embeds; **no clean multiLang API** like VidLink. Server pick often language-skewed; PW captures whatever default server loads. |
| **Probe** | Embed GET 200, TTFB ~1.37s (slower than CF peers) |
| **Pros** | Large legacy catalog; still used widely as “vidsrc.pro”; DE origin helps EU |
| **Cons** | PW-heavy; no first-class public stream API; US path longer to Hetzner; ads/obfuscation in embed; reverse APIs bitrot |
| **Faster same-coverage alts** | **Vixsrc / VidLink** for EN HLS. **SuperEmbed VIP** (`multiembed.mov/directstream.php`) for multi-server iframe fallback. |
| **Smoothness (EU/US)** | **EU: OK. US: mediocre.** Resolve latency dominates. |

---

### 5. NoTorrent — Pulse

| Field | Detail |
|-------|--------|
| **Site / API** | Stremio-compatible: `https://addon-osvh.onrender.com` |
| **Friendly name** | Pulse |
| **How to get stream URL** | **HTTP JSON API, no Playwright** |
| **Resolve path** | TMDB → IMDB via lookup → `GET /stream/movie/{imdb}.json` or `/stream/series/{imdb}:{s}:{e}.json` → pick best non-external stream (prefer `.m3u8`) |
| **Code** | `providers/notorrent.ts` |
| **CDN** | **Highly mixed:** sample streams included `voxzer.org` HLS, bare IP HTTP MP4, `hostingersite.com` PHP wrappers, Cloudflare Workers (`notorrent2.workers.dev`). |
| **multiLang EN** | **Yes, explicit.** Titles include “Original Audio”, plus 🇪🇸 Castellano, 🇵🇹 Português, etc. Filter for Original/EN for household default. |
| **Probe** | Addon origin Render **US-west** + CF; stream list returns multi-lang quickly when warm |
| **Pros** | No PW; multi-lang labels; broad catalog (catalog sites claim Netflix/Disney/etc packages); free Stremio ecosystem |
| **Cons** | Free Render **cold starts**; many **non-CDN / geo-fragile** URLs; CineHome already downranks `hostingersite.com` / `.php?`; direct IP MP4 has no ABR; mid-play death common |
| **Faster same-coverage alts** | **MediaFusion / Comet / AIOStreams** (Stremio HTTP) if debrid available — better stability than free NoTorrent. For pure free HTTP: **VidLink multiLang** more consistent. |
| **Smoothness (EU/US)** | **Unpredictable.** Best when voxzer-style HLS hits a real CDN; worst on hostinger/IP. |

---

## Additional providers (in CineHome tree but not 5-source UI lineup)

### Videasy (multi-server aggregator)

| Field | Detail |
|-------|--------|
| **API** | `https://api.videasy.net/{provider}/sources-with-title` |
| **Extract** | Encrypted response → `enc-dec.app/api/dec-videasy` (**no PW**, but **third-party decrypt dependency**) |
| **Servers** | Neon, Yoru, Cypher, Reyna, Omen, Breach, Ghost, Sage, Vyse, Raze (myflixerz, moviebox, primewire, onionplay, m4uhd, 1movies, hdmovie, superflix, …) |
| **multiLang** | Depends on upstream server |
| **Risk** | `enc-dec.app` SPOF; design doc plans circuit breaker |
| **Use** | Coverage filler when Luna/Phoenix miss |

### Lordflix

| Field | Detail |
|-------|--------|
| **API** | `https://snowhouse.lordflix.club` + enc/dec via `enc-dec.app` |
| **Servers** | Berlin, Marseille, Backrooms, Phoenix, Oslo, Luna, Sakura, Rio, Ativa, Moscow |
| **Extract** | No PW; encrypt URL → fetch → decrypt HLS playlist |
| **Risk** | Same enc-dec SPOF; multi-server fan-out is heavy |
| **Use** | Optional enrich; not in display lineup |

---

## Ecosystem status 2025–2026

| Provider / domain | Status (mid-2026) | Extract notes | Smoothness notes |
|-------------------|-------------------|---------------|------------------|
| **vidsrc.pro** | **Redirects to embed.su** | Use embed.su paths | Same as Nova |
| **embed.su** | **Live** (Hetzner/Angie) | PW or reverse hash API (stale libs) | EU-biased origin |
| **vidsrc.me / .io / .xyz / …** | **Domain churn** — official list at vidsrc.domains; many OLD/DEAD | Embed-only; heavy scrape | Unreliable brand |
| **vidsrc-embed.ru / .su / vsrc.su** | Listed **Live** on vidsrc.domains | Classic vidsrc embed | Prefer newer Vixsrc/VidLink for API |
| **vidsrc.cc** | Live (CF 403 without browser) | PW/scrape | Bot protection high |
| **vidsrc.icu** | DNS empty / dead in probe | — | Skip |
| **vidsrc.to** | Still referenced; competitor graphs active | Scrape ecosystem | Not in CineHome |
| **SuperEmbed** | **Live** `superembed.stream` | Iframe via **multiembed.mov** | Ads; multi host |
| **multiembed.mov** | **Live** (CF) | Embed + **VIP** `directstream.php` (HLS multi-quality) | VIP path best; still embed-centric |
| **SmashyStream** | **Domain shift**: `embed.smashystream.com` → **301 anyembed.xyz** | `playere.php?tmdb=` | Churn risk |
| **smashystream.xyz** | Live (CF marketing) | — | Not primary API |
| **1vid1shar** | **DNS dead** (probe empty) | — | **Dead — skip** |
| **moviesapi.club** | DNS empty in probe | Historic free API | Unreliable 2026 |
| **2embed** | Legacy; SuperEmbed positions as alternative | Embed | Ads-heavy |
| **vidsrc-bypass (GitHub)** | **Archived 2024-10** | embed.su / vidsrc.rip / vidlink / vidsrc.icu | Bitrot risk |
| **Vidlink.pro-Decryptor** | Active concept (pure Python nacl) | Confirms no-PW path | Aligns with CineHome `vidlink-api.ts` |
| **NoTorrent (Stremio)** | Listed on stremio-addons.net | Stremio stream JSON | Free tier instability |
| **Vixsrc** | **Live**, “next gen streaming API” | Official embed + list API + token playlist | **Best API story 2026** |
| **VidLink** | **Live**, biggest multi-source claim | Embed + encrypted `/api/b/*` | Best multiLang |
| **Vidking** | **Live** embed player product | Embed only | Best as PW fallback |

### SuperEmbed / multiembed (practical)

```
# Simple embed
https://multiembed.mov/?video_id={tmdb}&tmdb=1
https://multiembed.mov/?video_id={tmdb}&tmdb=1&s={s}&e={e}

# VIP HLS player (prefer)
https://multiembed.mov/directstream.php?video_id={tmdb}&tmdb=1
# check availability: &check=1 → 0|1
```

- Servers: streamtape, doodstream, mixdrop, streamsb, voe, upstream, abyss, streamhide + “premium VIP HLS”
- **Extract without PW:** hard for host-specific links; VIP may expose HLS but still player-gated
- **Not recommended as primary** for CineHome custom player (ads, popup, multi-hop hosts)

### SmashyStream (practical)

```
# Legacy (redirects)
https://embed.smashystream.com/playere.php?tmdb={id}
https://embed.smashystream.com/playere.php?tmdb={id}&season={s}&episode={e}
# → anyembed.xyz/embed/tmdb-movie-{id}
```

- Treat as **unstable identity** (rebrand chain). Use only as last-resort iframe, not core extract.

---

## Extract strategy matrix (no Playwright when possible)

| Provider | PW needed? | Method | Complexity | Stability |
|----------|------------|--------|------------|-----------|
| Vixsrc | **No** | API + HTML token | Low | High |
| VidLink | **No** | nacl token + JSON walk | Medium (key risk) | High |
| NoTorrent | **No** | Stremio JSON | Low | Medium |
| Videasy | **No*** | API + enc-dec.app | Medium | Medium (SPOF) |
| Lordflix | **No*** | API + enc-dec.app | Medium | Medium (SPOF) |
| Vidking | **Yes** (today) | Network capture | High | Medium |
| Embed.su | **Yes** (today) | Network capture | High | Medium |
| SuperEmbed VIP | Maybe | directstream / host resolve | High | Low–Med |
| Classic vidsrc.* | Usually yes | Nested iframes | High | Low |

\*No browser, but **depends on third-party decrypt service**.

### Recommended extract policy for CineHome

1. **Always:** Vixsrc fast path (`fast=1`) — already shipped.  
2. **Parallel API enrich:** VidLink `multiLang=1` + NoTorrent (filter EN/Original + HLS only).  
3. **Playwright last resort:** only if `sources < MIN_SOURCES_TARGET` — Vidking then Embed.su.  
4. **Optional:** Videasy/Lordflix behind circuits + `PROVIDER_*=0` kill switches.  
5. **Do not add:** 1vid1shar (dead), raw smashy domain chain, unmaintained vidsrc-bypass without re-RE.

---

## CDN characteristics summary

| CDN / host family | Provider | Infra | EU | US | Notes |
|-------------------|----------|-------|----|----|-------|
| Cloudflare (site) | Vixsrc, VidLink, Vidking, multiembed | Global Anycast | ✅ | ✅ | Front door only; media may differ |
| `*.hakunaymatata.com` | VidLink | **CloudFront** | ✅ | ✅ | Best multi-region media for household |
| `storm.vodvidl.site` | VidLink | Cloudflare | ✅ | ✅ | Referer required |
| `*.ironbubble.site` / infantino | Vidking | Cloudflare | ✅ | ✅ | Referer required |
| embed.su origin | Nova | **Hetzner DE** | ✅ | ⚠️ | Origin lag for US home servers |
| `addon-osvh.onrender.com` | NoTorrent meta | Render US-west | ⚠️ | ✅ | Meta API only; streams elsewhere |
| `*.hostingersite.com` | NoTorrent etc. | Shared host | ❌ | ❌ | CineHome score penalty already |
| Bare IP HTTP | NoTorrent | Single machine | ❌ | ❌ | No ABR, geo fragile |
| `*.voxzer.org` | NoTorrent HLS | Third-party stream | ? | ? | Prefer over hostinger when present |

---

## multiLang English — quick reference

| Provider | EN works? | How |
|----------|-----------|-----|
| Vixsrc | ✅ Default | API `lang=en`; param `lang=` on embed |
| VidLink | ✅ Best | `?multiLang=1` → multi audio tracks in HLS |
| Vidking | ✅ Usually | Single default track (EN for Hollywood) |
| Embed.su | ⚠️ | Depends on which server embed picks |
| NoTorrent | ✅ Labeled | Prefer titles with “Original Audio”; skip 🇪🇸/🇵🇹 if EN wanted |
| SuperEmbed | ⚠️ | Server-dependent |
| Smashy | ⚠️ | Had region players historically; unstable now |

---

## Ranking rationale (EU/US + Tailscale) — detail

### Score dimensions (weights)

| Dimension | Weight | Rationale |
|-----------|--------|-----------|
| Media CDN quality (EU/US edges) | 30% | Segment throughput after first frame |
| Resolve TTFF / no-PW | 25% | Home server CPU + time-to-play |
| Stream format (HLS ABR vs MP4) | 15% | Adaptive under Tailscale jitter |
| Mid-play stability (auth/referer) | 15% | Avoid fatal mid-episode |
| Coverage + multiLang EN | 10% | Hit rate for household titles |
| Ops risk (key rot, SPOF, domain churn) | 5% | Maintenance burden |

### Rank 1 — Vixsrc/Luna
Wins resolve + reliability. Signed HLS + CF. Already product default. Best household “press play” experience.

### Rank 2 — VidLink/Phoenix
Wins multiLang + CloudFront. Slightly slower resolve (crypto + verify) but excellent sustained play for EU/US edges.

### Rank 3 — Vidking/Solstice
Excellent CF media once running; **Playwright tax** on a shared laptop server tanks concurrent UX. Keep as quality alternate, not primary resolve.

### Rank 4 — Embed.su/Nova
Hetzner DE helps EU home servers somewhat; US worse. PW + no clean API. Still useful as 4th source slot.

### Rank 5 — NoTorrent/Pulse
Great for filling EN/ES/PT gaps and obscure titles; **do not prefer for smoothness**. Filter aggressively (HLS only, reject hostinger/php/IP).

---

## Suggested CineHome source policy (actionable)

```
fast path (≤10s):
  Vixsrc only → return Luna if verified

full path (parallel):
  VidLink multiLang=1
  NoTorrent (keep: .m3u8 + EN/Original; drop hostinger/php/ip-http)
  [optional] Videasy/Lordflix if circuits closed

if sources < 5:
  Playwright: Vidking → Embed.su

playback rank:
  Luna > Solstice > Phoenix > Nova > Pulse
  (or smoothness-first: Luna > Phoenix > Solstice > Nova > Pulse)
```

**Proxy allowlist additions to consider when validating new CDNs:**  
any new hosts from VidLink/NoTorrent verify passes should be added to `CDN_HOSTS` + `REFERER_OVERRIDES` in `hls-proxy.ts`.

---

## Faster alternatives with similar content coverage

| Goal | Prefer | Avoid |
|------|--------|-------|
| Fastest EN movie/TV start | **Vixsrc** | PW embeds first |
| Multi audio / subs | **VidLink multiLang** | Single-server embeds |
| Max coverage free HTTP | VidLink + Vixsrc + NoTorrent + Videasy | Single provider |
| Stability (paid) | Debrid + Stremio (Torrentio/Comet/MediaFusion) | Free hostinger chains |
| Drop Playwright entirely | Vixsrc + VidLink + NoTorrent (+ re-RE Vidking later) | Embed.su until API re-RE |
| EU home server origin bias | Vixsrc/VidLink CF+CloudFront; Embed.su DE | Bare Asia/IP hosts |
| US home server | CloudFront hakunaymatata + CF | Hetzner-only origins |

---

## Probe appendix (2026-07-09, probe host AU/MEL — infra type still valid)

| Target | HTTP | Infra signal | TTFB (probe) |
|--------|------|--------------|--------------|
| vixsrc.to | 200 | Cloudflare | ~0.48s |
| vixsrc.to/api/movie/786892 | 200 | CF | ~0.40s |
| vidlink.pro | 200 | CF + Next | ~0.67s |
| www.vidking.net | 200 | CF | ~0.05s |
| embed.su | 200 GET | Hetzner Angie | ~1.37s |
| multiembed.mov | 200 | CF | ~0.65s |
| addon-osvh.onrender.com | 200 | Render US-west + CF | ~0.20s |
| sacdn.hakunaymatata.com | 403 bare | **CloudFront** | n/a (auth) |
| storm.vodvidl.site | 403 bare | CF | n/a (auth) |
| moon.ironbubble.site | 200 | CF | n/a |
| vidsrc.pro | 301→embed.su | CF | — |
| 1vid1shar.com | DNS fail | dead | — |
| vidsrc.icu | DNS empty | dead | — |
| embed.smashystream.com | 301→anyembed.xyz | churn | — |

---

## Sources (code + public)

- CineHome: `/Users/husnainali/cinehome-app/mini-services/stream-scraper/` (`index.ts`, `vidlink-api.ts`, `providers/*`)
- CineHome: `src/lib/hls-proxy.ts` CDN allowlist + referer overrides
- CineHome: `docs/CINEHOME-OVERHAUL-DESIGN.md` (Luna-first, multiLang inventory)
- https://vixsrc.to/ — API docs, `lang` param
- https://vidlink.pro/ — embed API, player events
- https://www.vidking.net/ — embed routes
- https://www.superembed.stream/ — multiembed.mov VIP
- https://vidsrc.domains/ — official vidsrc domain list
- https://github.com/heyitswit/vidsrc-bypass — archived embed.su/vidlink extract patterns
- https://github.com/walterwhite-69/Vidlink.pro-Decryptor — pure nacl VidLink extract
- Live DNS/HTTP probes 2026-07-09

---

## Bottom line

For a **EU/US home server behind Tailscale**, optimize for **API-extracted HLS on multi-edge CDNs**:

1. **Vixsrc (Luna)** — best smoothness default  
2. **VidLink (Phoenix)** — best multiLang EN + CloudFront  
3. **Vidking (Solstice)** — strong CDN, expensive resolve  
4. **Embed.su (Nova)** — coverage slot; Hetzner/EU-leaning; PW  
5. **NoTorrent (Pulse)** — coverage/lang filler only after quality filters  

**Avoid resurrecting dead brands** (1vid1shar, vidsrc.icu). **Treat smashy/multiembed as iframe fallbacks, not core extract.** **Prefer re-RE of Vidking player JSON over more Playwright.**
