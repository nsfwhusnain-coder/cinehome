# Competitor Architectures: Multi-Source Movie Watch UX (2024–2026)

**Date:** 2026-07-09  
**Audience:** CineHome BOSS / architect  
**Scope:** Open-source (and open-ecosystem) projects that solve “watch movies via multi-source scrapers” with strong UX.  
**CineHome baseline:** Next.js 16 + Bun + Prisma SQLite + `mini-services/stream-scraper` (port 3030 internal) + session HLS proxy + hls.js/dash.js player. Providers today: Vixsrc (Luna-first), VidLink API, Lordflix, Videasy, NoTorrent, Playwright embeds.

**Important naming collision:** The [CinePro](https://cinepro.cc) ecosystem also ships a product called **CineHome** (download automation to NAS). That is **unrelated** to this household Next.js app at `cinehome-sot`. Where needed, “our CineHome” vs “CinePro-CineHome” is spelled out.

**Legal note:** This is architecture research for a private household resolver stack. Scraping third-party streams has ToS/copyright risk; owned-media paths (Jellyfin) are the clean legal model.

---

## Comparison matrix (at a glance)

| Project | Model | Quality reputation | Self-host difficulty | Fits our Next.js stack? |
|--------|--------|--------------------|----------------------|-------------------------|
| movie-web / sudo-flix | Client-side multi-provider scrape + optional proxy | High UX; stream quality = source host (often 720–1080, occasional 4K) | Easy frontend; proxy/backend optional | **Yes** — React/TS DNA; providers package reusable server-side |
| cinepro-org | Server scraper API (OMSS) + React UI + download tools | 50+ sources claim; quality varies by provider; parallel decrypt pipelines | Easy (Docker one-liner) | **Excellent** — TS/Node, Docker, proxy pattern mirrors us |
| VidLink decryptors | Single-provider API → direct M3U8 | Often fast / high quality when live; single-vendor risk | Easy (Python FastAPI or raw HTTP) | **Already in stack** (`PROVIDER_VIDLINK`) |
| Jellyseerr + Jellyfin | Owned media request → *arr → download → serve | Best quality (Remux/HDR/Atmos if you store it) | Medium–hard (multi-container + disk) | **Partial** — complementary path, not scraper replacement |
| Stremio + torrents/debrid | Client + addon protocol + magnets/HTTP | Best with Real-Debrid (cached 4K Remux common); P2P alone flaky | Easy client; zero server if public addons | **Poor as core** — different runtime; ideas transferable |

---

## 1. movie-web / sudo-flix forks

### What it is

- **movie-web**: landmark open-source “watch anything” SPA (React). Original public site faced takedowns; community continued via forks.
- **sudo-flix** (`sussy-code/smov` and related): the most active spiritual successor / fork line with community instances, docs, proxy, and backend pieces.
- **`@movie-web/providers`** (also maintained in sudo-flix lineage as `sussy-code/providers`): the reusable scraper package — “soul” of the product.

### Architecture (text diagram)

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser SPA (React / Vite-style frontend)                       │
│  - TMDB catalog browse / search / watch progress (optional BE)   │
│  - Player UI (source picker, quality, captions)                  │
└────────────────────────────┬────────────────────────────────────┘
                             │ 1) Resolve metadata (TMDB/IMDB)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  @movie-web/providers  (runs in browser OR Node)                 │
│                                                                  │
│  Provider runners → Source scrapers → embed/token extractors     │
│  Parallel provider attempts; first/best stream wins or list all  │
└───────────────┬─────────────────────────────┬────────────────────┘
                │ CORS / headers / scrape HTTP │
                ▼                              ▼
     ┌──────────────────┐           ┌──────────────────────┐
     │ Optional CORS    │           │ Optional account BE  │
     │ proxy (sudo-proxy│           │ (progress, sync,     │
     │ Railway/self-host│           │ community instances) │
     └────────┬─────────┘           └──────────────────────┘
              │ inject Referer/Origin as needed
              ▼
     Upstream CDN m3u8 / mp4  →  video element / hls.js
```

**Key architectural choices:**

| Choice | Why it matters |
|--------|----------------|
| **Scrape in the client** | Spreads load; no central scraper bill; hard to “take down the API” |
| **Providers as a library** | Forks reuse the same package; UI and scrape logic decouple |
| **Optional thin proxy** | Only for CORS/header injection — not full segment re-proxy by default |
| **Works browser + server** | Same scrapers can be lifted into a backend (CineHome-style) |

### Playback quality reputation

- UX reputation (2024–): among the best “pirate Netflix clones” — clean UI, multi-source fallback, captions when available.
- Stream quality is **host-dependent**: often solid 720p/1080p HLS; 4K appears on some titles when providers expose it.
- Reliability: **provider churn**. A fork’s quality track is really “how fresh is `@providers` + which hosts still work.”
- Compared to debrid/torrent Remux: usually **worse bitrates / more soft encode**; compared to random free sites: **better UX and multi-source resilience**.

### Self-host difficulty

| Component | Difficulty | Notes |
|-----------|------------|-------|
| Frontend only | ★☆☆ Easy | Static deploy / Docker; point at public TMDB |
| + CORS proxy | ★★☆ | Needed for many sources from browser |
| + Full private stack | ★★☆ | Backend for progress optional |
| Maintaining providers | ★★★ Hard ongoing | Upstream sites break weekly |

### Fit for our CineHome Next.js stack

| Fit | Detail |
|-----|--------|
| **Strong** | TypeScript providers concept maps 1:1 to `mini-services/stream-scraper/providers/*` |
| **Strong** | Source-list UX patterns (try next source, quality labels) align with our multi-source player |
| **Medium** | Client-side scrape conflicts with our model (auth’d server scraper + HLS session proxy) — **steal ideas, not the client scrape** |
| **Weak** | No first-class household multi-user PIN / family model like ours |

**Steal vs skip:** Steal provider runner + ranking UX. Do **not** move scrape into the browser for household product (SSRF, key leakage, harder auth).

---

## 2. cinepro-org (Core + UI + download “CineHome”)

### What it is

Open multi-source **server-side** streaming ecosystem (2025–2026):

| Piece | Role |
|-------|------|
| **cinepro-org/core** | TypeScript scraper backend; OMSS HTTP API; Docker/GHCR; Redis cache; built-in stream proxy |
| **cinepro-org/ui** | React reference UI (public beta `ui.cinepro.cc`) |
| **CinePro-CineHome** (WIP) | Download automation (backend + Next.js FE) — **not our app** |
| **@omss/framework** | Shared provider base class, discovery, proxy URL helper |
| **Stremio addon mode** | Optional `/stremio/manifest.json` |
| **MCP mode** | Optional AI agent stream query |

Claim: up to **50+ unique playable sources** per title via fan-out providers (VidNest, Tulnex, Peachify, VidZee, VixSrc, VidApi, StreamMafia, Popr, etc.). License: **PolyForm Noncommercial 1.0.0**. Core rewrite warning existed mid-2026 on docs (treat as active but volatile).

### Architecture (text diagram)

```
┌────────────────┐     ┌──────────────────────────────────────────┐
│ CinePro UI     │     │ Other clients (Stremio, custom Next.js)  │
│ (React SPA)    │     │                                          │
└───────┬────────┘     └───────────────────┬──────────────────────┘
        │ GET /movie|tv/{tmdb} sources     │
        ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  CinePro Core  (@omss/framework)                                 │
│  - TMDB validation                                               │
│  - discoverProviders(src/providers/**)  auto-load                │
│  - Promise-style fan-out across enabled providers                │
│  - Redis response cache + refresh-by-responseId                  │
│  - Filter to playable-only (unless INTERNAL_DEBUG)               │
│  - createProxyUrl() → built-in header-inject proxy               │
└───────────┬───────────────────────────┬─────────────────────────┘
            │ parallel HTTP + decrypt   │
            ▼                           ▼
   Provider A (VidNest multi-backend)  Provider B (VidZee parallel AES)
   Provider C (VixSrc API)             Provider N …
            │
            ▼
   Aggregated sources + subtitles + audioTracks + diagnostics
            │
            ▼
   Client player → Core proxy → CDN m3u8/mp4
```

**Provider contract (steal-worthy):**

```
BaseProvider {
  id, name, enabled, BASE_URL, HEADERS, capabilities
  getMovieSources(media) → { sources, subtitles, diagnostics }
  getTVSources(media)    → same
  healthCheck()          → boolean
  createProxyUrl(url, headers)  // never return naked CDN URLs
}
```

Best practices from their docs:

- Never throw — return diagnostics so one bad provider does not kill the aggregate.
- `enabled = false` instead of deleting dead providers.
- Stateless provider instances.
- Proxy every stream URL for Referer/Origin.

### Playback quality reputation

- Source **quantity** is the brand (dozens of candidates).
- Quality: mixed; they normalize quality labels and attach audio language metadata.
- Reliability work in 2026 changelogs: parallel decrypt (VidZee), playable-only filter, reachability checks (CineSu), multi-backend fan-out (Tulnex/VidNest).
- Operational caveat: public Core is “insecure by default” and DDoS-expensive (they recommend local/personal use).

### Self-host difficulty

| Path | Difficulty | Notes |
|------|------------|-------|
| `docker run … ghcr.io/cinepro-org/core` | ★☆☆ | TMDB key only |
| Docker Compose + Redis | ★★☆ | Production caching |
| Cloudflare Workers / Vercel | ★★☆ | Serverless deploy buttons |
| UI + Core pair | ★★☆ | Point UI at Core `PUBLIC_URL` |
| Ongoing provider maintenance | ★★★ | Same industry tax as everyone |

### Fit for our CineHome Next.js stack

| Fit | Detail |
|-----|--------|
| **Excellent** | Same problem domain: TMDB ID → multi-provider → proxy → player |
| **Excellent** | Provider auto-discovery + BaseProvider interface is a clean upgrade target for our ad-hoc provider files |
| **Excellent** | Built-in proxy + audioTracks/subtitles in the API model |
| **Good** | Could theoretically call Core as an external aggregator (license: noncommercial personal OK) |
| **Caution** | Their “CineHome” product name collides; do not confuse download-automation with our streamer |
| **Caution** | PolyForm Noncommercial — fine for household, not for any commercial fork |

**Closest competitor to our architecture.** Highest density of stealable server patterns.

---

## 3. VidLink decryptor deployments

### What it is

**VidLink.pro** is a commercial/community **embed + API** for movies/TV by TMDB ID (`/movie/{tmdbId}`, `/tv/{tmdbId}/{s}/{e}`). Many frontends iframe it; better stacks extract **direct M3U8**.

**Open reverse-engineering path:**  
[`walterwhite-69/Vidlink.pro-Decryptor`](https://github.com/walterwhite-69/Vidlink.pro-Decryptor) — pure-Python FastAPI that reimplements VidLink’s WASM crypto:

1. 24-byte nonce  
2. Media ID + 64-bit BE timestamp payload  
3. **XSalsa20-Poly1305** (PyNaCl) with reversed production key  
4. Adaptive time-sync for token TTL  
5. **curl_cffi** Chrome TLS fingerprint to beat Cloudflare  

Endpoints: `GET /movie/{tmdb_id}`, `GET /tv/{tmdb_id}/{s}/{e}` → direct sources.

Our app already has a first-party VidLink path (`vidlink-api`, kill switch `PROVIDER_VIDLINK=0`) and related patches under `cinehome-patches/`.

### Architecture (text diagram)

```
┌──────────────────────┐
│ Client / CineHome    │
│ scraper or iframe    │
└──────────┬───────────┘
           │ tmdbId (+ s/e)
           ▼
┌──────────────────────────────────────────┐
│ Decryptor service (Python FastAPI)       │
│  OR native TS reimpl of token protocol   │
│                                          │
│  build_token(media_id, timestamp)        │
│  encrypt XSalsa20-Poly1305               │
│  GET VidLink API with Chrome JA3/TLS     │
│  parse JSON → m3u8 list                  │
└──────────┬───────────────────────────────┘
           │ direct playlist URLs + headers
           ▼
┌──────────────────────────────────────────┐
│ HLS proxy (session, Referer, segment LRU)│
└──────────┬───────────────────────────────┘
           ▼
        Player
```

**Deployment variants seen in the wild:**

| Variant | Pros | Cons |
|---------|------|------|
| Official iframe embed | Zero crypto work | Ads/UI chrome, no multi-source control |
| Hosted public decryptor | Instant integration | Trust + uptime + ToS risk |
| Self-host Python decryptor | Full control | Extra runtime (Python) beside Bun |
| Native token in Bun scraper | One process | Key/algorithm breaks need code updates |

### Playback quality reputation

- Frequently cited as a **fast, high-quality single hop** for popular titles.
- Still one vendor: outages, key rotations, and WAF changes black out the whole provider.
- Best used as **one of N** sources, never sole dependency (CineHome already treats it that way).

### Self-host difficulty

| Approach | Difficulty |
|----------|------------|
| iframe only | ★☆☆ |
| Python decryptor container | ★★☆ (pip + FastAPI + key drift) |
| In-process API client (what we do) | ★★☆ until crypto/WAF breaks, then fire drill |

### Fit for our CineHome Next.js stack

| Fit | Detail |
|-----|--------|
| **Already integrated** | Keep as optional fast API provider |
| **Idea** | Time-sync + TLS fingerprint (curl_cffi / curl-impersonate) generalizes to other CF-gated hosts |
| **Avoid** | Publishing a public decryptor; keep 3030 internal |

---

## 4. Jellyseerr + Jellyfin (owned media path)

### What it is

The dominant **legal / owned-library** home cinema stack (often with the *arr suite). Not a multi-source web scraper — a **request → acquire → library → stream** pipeline.

| Component | Role |
|-----------|------|
| **Jellyseerr** | Netflix-like request UI; auth against Jellyfin users |
| **Radarr / Sonarr** | Movie / TV acquisition managers |
| **Prowlarr** | Indexer aggregation |
| **qBittorrent / SABnzbd** | Download clients |
| **Bazarr** | Subtitle automation |
| **Jellyfin** | Media server, clients, hardware transcode |

### Architecture (text diagram)

```
┌──────────────────────────────────────────┐
│ Jellyseerr (request portal)              │
│  search TMDB → Request → approve/auto    │
└──────────────────┬───────────────────────┘
                   │ API
        ┌──────────┴──────────┐
        ▼                     ▼
   ┌─────────┐           ┌─────────┐
   │ Radarr  │           │ Sonarr  │
   └────┬────┘           └────┬────┘
        │                     │
        ▼                     ▼
   ┌──────────────────────────────────┐
   │ Prowlarr → indexers              │
   └──────────────────┬───────────────┘
                      │ grab
                      ▼
   ┌──────────────────────────────────┐
   │ Download client (qbit / usenet)  │
   └──────────────────┬───────────────┘
                      │ import + rename
                      ▼
   ┌──────────────────────────────────┐
   │ Library on disk (movies/tv)      │
   │ optional Bazarr subs / Tdarr     │
   └──────────────────┬───────────────┘
                      │ library scan
                      ▼
   ┌──────────────────────────────────┐
   │ Jellyfin → clients (web, TV, RN) │
   │ direct play or HW transcode      │
   └──────────────────────────────────┘
```

### Playback quality reputation

- **Best-in-class** when library has quality profiles (e.g. Remux / 4K HDR / Atmos).
- No third-party CDN roulette; quality is whatever you downloaded.
- Trade-off: **latency to first watch** (minutes–hours) vs scraper **seconds**.
- Transcode quality depends on GPU (Intel QSV / NVENC / Apple / etc.).

### Self-host difficulty

| Setup | Difficulty | Why |
|-------|------------|-----|
| Jellyfin alone (manual files) | ★★☆ | Simple but no request UX |
| Full *arr + Jellyseerr + VPN | ★★★–★★★★ | Many containers, paths, perms, indexers, disk |
| Ongoing | ★★★ | Disk growth, indexers die, perms (PUID/PGID) |

Your host already co-resides qBittorrent etc. — partial path exists in ops reality.

### Fit for our CineHome Next.js stack

| Fit | Detail |
|-----|--------|
| **Complementary** | “Watch now” (scraper) vs “Own it” (request → library) |
| **Medium** | Jellyfin has APIs; could deep-link “Available in library” badge on detail pages |
| **Medium** | Jellyseerr-like **request button** for family if scrapers miss a title |
| **Poor as replacement** | Different product; our non-goal list already says no hosted torrent client as core playback |
| **UX steal** | Request status pipeline, availability badges, multi-user library-aware UI |

Our overhaul design already treats hosted media as non-goal for main playback — still worth a **soft integration** later, not a rewrite.

---

## 5. Stremio + torrents (different model)

### What it is

**Stremio** = multi-platform media **client** with an **addon protocol**. Content is not baked into the app; addons return:

- catalog / meta  
- **stream objects** (HTTP URLs or magnet/infoHash)

Popular 2024–2026 combo:

| Layer | Examples |
|-------|----------|
| Meta | Cinemeta, TMDB addons |
| Streams | **Torrentio**, MediaFusion, Comet, AIOStreams (meta-addon) |
| Acceleration | **Real-Debrid / AllDebrid / Premiumize / TorBox** (cached torrents → HTTP) |
| Subs | OpenSubtitles-style addons |

### Architecture (text diagram)

```
┌─────────────────────────────────────────────┐
│ Stremio Client (desktop / mobile / TV / web)│
│  - installs addons by manifest URL          │
│  - for title X: query all stream addons     │
│  - user picks stream row (quality, RD+, …)  │
└────────────────────┬────────────────────────┘
                     │ HTTP Addon Protocol
          ┌──────────┴───────────┐
          ▼                      ▼
┌──────────────────┐   ┌─────────────────────────┐
│ Meta addon       │   │ Stream addon (Torrentio)│
│ catalogs + IDs   │   │ scrape trackers / APIs  │
└──────────────────┘   └───────────┬─────────────┘
                                   │ magnets / hashes
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
           ┌───────────────┐            ┌─────────────────┐
           │ P2P in client │            │ Debrid API      │
           │ (slow/seeded) │            │ cached → HTTPS  │
           └───────────────┘            └────────┬────────┘
                                                 ▼
                                            Player
```

**Meta-addon pattern (AIOStreams etc.):** one configured addon fans out to many underlying addons, dedupes, ranks — same idea as multi-provider server aggregation.

### Playback quality reputation

| Mode | Reputation |
|------|------------|
| Torrentio + Real-Debrid | **Excellent** — often Remux/4K when cached; low buffer; IP not in swarm |
| P2P only | Hit-or-miss; seeders; legal/VPN considerations |
| HTTP scraper addons | Usually weaker than debrid; flakier |

Community consensus 2025–2026: debrid-backed Stremio is the **quality king** of “no personal library” setups; scraper sites win on “zero subscription, zero install.”

### Self-host difficulty

| Piece | Difficulty |
|-------|------------|
| Install Stremio + public Torrentio | ★☆☆ |
| + Real-Debrid account | ★☆☆ (paid) |
| Self-host every addon | ★★★ |
| Self-host full debrid alternative | ★★★★ |

Almost **no server** required for the happy path — opposite of our always-on household Docker app.

### Fit for our CineHome Next.js stack

| Fit | Detail |
|-----|--------|
| **Poor as primary architecture** | Desktop/TV client + addon economy ≠ Next.js household app |
| **Idea transfer** | Stream row ranking (quality, codec, debrid badge, size) |
| **Idea transfer** | Meta-addon / parallel query + dedupe |
| **Optional later** | Expose a Stremio-compatible manifest from our scraper (CinePro already does) for TV clients — only if we want Stremio as a front-end |
| **Non-goal alignment** | Design doc: no torrent client as core path |

---

## Cross-cutting patterns that win UX (2024–2026)

Regardless of model, products users stick with share:

1. **TMDB-first catalog** — posters, logos, seasons, recommendations (not a dump of filenames).
2. **Multi-source list, not single auto-pick only** — show ranked sources; auto-play best; allow manual switch.
3. **Progressive resolution** — fast first source, background enrich (we already have Luna-first + enrich).
4. **Proxy with correct headers** — Referer/Origin/cookies or streams 403.
5. **Provider isolation** — one dead host must not block others (circuits, diagnostics, no throws).
6. **Quality + language labels** — 1080p · H264 · EN / dual audio visible before play.
7. **Failover** — on `MEDIA_ERR` or empty playlist, try next source without full page reload.
8. **Subtitle tracks as first-class** — not an afterthought dock placeholder.
9. **Kill switches / health** — ops can disable flaky providers without redeploying UI.
10. **Personalization** — continue watching, preferences (audio lang, default quality).

---

## Fit summary vs our CineHome stack

```
                    Scrapers / resolve-now          Own / request later
                    ─────────────────────          ───────────────────
Closest DNA:        CinePro Core                   Jellyseerr+Jellyfin
UX gold:            movie-web / sudo-flix UI       Jellyfin clients
Fast single hop:    VidLink decryptors             n/a
Quality ceiling:    Stremio+Debrid (external)      Remux on disk

Our stack today:    Next.js UI ──► stream-scraper ──► HLS session proxy ──► hls.js
                    (already CinePro-like; UI chasing LordFlix/movie-web polish)
```

| Capability | We have | Best peer |
|------------|---------|-----------|
| Multi-provider fan-out | Yes (partial) | CinePro / movie-web providers |
| Fast path + background enrich | Yes | Lordflix-style / our own |
| Circuit breakers | Yes | Enterprise scrapers |
| Session HLS proxy + LRU | Yes | CinePro createProxyUrl / movie-web proxy |
| Source picker + failover UX | Partial | movie-web, Stremio stream list |
| Audio/sub metadata in API | Partial | CinePro ProviderResult |
| Provider auto-discovery | No (manual imports) | CinePro @omss |
| Owned-library hybrid | No | Jellyseerr availability |
| Debrid/torrent | Explicit non-goal | Stremio |

---

## Steal these ideas (for our CineHome)

Prioritized for **household Next.js + Bun scraper + HLS proxy**. Skip torrent/debrid core, skip client-side scrape, skip public multi-tenant SaaS.

### P0 — High impact, low architecture risk

1. **BaseProvider contract + auto-discovery** (from CinePro / @omss)  
   - Standardize `id`, `enabled`, `getMovie/TVSources`, `healthCheck`, diagnostics-on-error.  
   - Drop ad-hoc import lists; env kill switches map to `enabled`.

2. **Always proxy stream URLs with header bags** (CinePro `createProxyUrl`)  
   - Encode required Referer/Origin/cookies into session metadata (we have sessions — ensure every provider path uses them).

3. **Playable-only filter + diagnostics channel** (CinePro)  
   - Clients see streams that survived HEAD/playlist sniff; `/health` and debug mode surface `PARTIAL_SCRAPE` / provider errors.

4. **Stremio-style stream row ranking UX**  
   - Sort keys: preference match → H264 → resolution → latency/history success → language.  
   - Visible badges: quality, codec, audio lang, provider name, “fast” vs “enriched”.

5. **Auto-failover player** (movie-web UX)  
   - On fatal media error or empty m3u8, advance `failedSourceIds` without forcing Settings.  
   - Toast: “Source failed — trying next…”

6. **Parallel decrypt / multi-backend providers as one logical provider** (CinePro VidNest/Tulnex pattern)  
   - Lordflix already fans servers; generalize “one provider ID, many upstream servers, merge + dedupe.”

### P1 — UX polish users feel immediately

7. **movie-web / LordFlix progressive source discovery chrome**  
   - Skeleton source slots while enriching; never flash hard error if fast path empty but full still running (already partial in design doc).

8. **Audio track + subtitle objects in scraper JSON** (CinePro `audioTracks` / `subtitles`)  
   - Hide empty player-dock sections; wire real track selection.

9. **Quality label normalization**  
   - Single function: map `fullhd` / `1080` / `FHD` → `1080p`; prefer H264 in picker defaults (we have HEVC fallback caps — keep).

10. **Source identity dedupe**  
    - Dedupe by normalized host + resolution + codec, not raw URL (CDNs rotate query strings).

11. **Per-provider timings in health/smoke** (already partially on `/health`)  
    - Surface in admin/system-status UI like movie-web debug / CinePro INTERNAL_DEBUG lite.

12. **Refresh-by-responseId / cache bust** (CinePro refresh endpoint)  
    - “Retry full scrape” invalidates cache key for that title/episode instead of waiting TTL.

### P2 — Strategic / optional hybrid

13. **Soft Jellyfin library badge**  
    - If Jellyfin API configured: “In library — open” vs “Play via sources.” Does not replace scraper.

14. **Jellyseerr-like Request** for misses  
    - When all providers fail: Request → *arr (if present on host). Matches household ops without becoming a torrent UI.

15. **Optional Stremio manifest** exposing our resolved streams  
    - TV boxes run Stremio; we remain the resolver. Mirror CinePro `STREMIO_ADDON=true` — only if we want that surface.

16. **TLS impersonation default for WAF hosts** (VidLink decryptor / curl_cffi lesson)  
    - Standardize curl-impersonate or equivalent for CF-heavy providers; keep Playwright last resort.

17. **Meta-addon aggregation config** (AIOStreams idea)  
    - User/admin toggles which provider groups run (fast tier vs full tier) without code changes — beyond boolean env, a small config resource.

18. **Do not steal:** public instance culture, client-side only scrape, iframe-as-player primary, ads, PolyForm-incompatible commercial packaging of their code.

### Explicit non-steals (aligned with our design non-goals)

| Tempting idea | Why not |
|---------------|---------|
| Full *arr + torrent as main playback | Disk, legal surface, TTFF; design non-goal |
| Real-Debrid as required path | Paid third party; different product |
| Embed-only VidLink iframe | Breaks custom player, auth, proxy |
| Move scrape to browser | Household auth + SSRF + no central circuits |
| Depend on public CinePro Core instance | Abuse, ToS, availability; self-host or own providers |

---

## Recommended north-star architecture (ours + stolen best)

```
┌─────────────────────────────────────────────────────────────┐
│ Next.js 16 App (auth, TMDB browse, watch UI, player dock)   │
│  progressive useWatchPlayback: fast → enrich poll           │
└────────────────────────────┬────────────────────────────────┘
                             │ /api/playback (session required)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ stream-scraper :3030 (internal only)                        │
│  Provider registry (BaseProvider, env enables, circuits)    │
│  Tier A fast: Vixsrc/Luna, VidLink, …                       │
│  Tier B full: Lordflix multi-server, Videasy, NoTorrent, …  │
│  Tier C last: Playwright embeds (pool ≤2)                   │
│  normalize → dedupe → rank → cache (3m HLS / 15m general)   │
└────────────────────────────┬────────────────────────────────┘
                             │ sources[] + header bags
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ HLS/DASH session proxy  (/api/hls/[sessionId])              │
│  SSRF allowlist · segment LRU + byte-cap · metrics          │
└────────────────────────────┬────────────────────────────────┘
                             ▼
                    hls.js / dash.js player
                    auto-failover · tracks · next episode
```

Optional later:

```
Jellyfin ──badge/link──► same detail page
Jellyseerr request ──when scrapers empty──► *arr (existing host qbit)
```

---

## Source index (research crawl)

| Project | Primary refs |
|---------|----------------|
| movie-web / sudo-flix | `sussy-code/providers`, `sussy-code/smov`, providers docs, community instances |
| CinePro | github.com/cinepro-org/core, docs.cinepro.cc, ui.cinepro.cc, @omss/framework |
| VidLink | vidlink.pro, walterwhite-69/Vidlink.pro-Decryptor, our `vidlink-api` |
| Jellyfin stack | jellyfin.org, fallenbagel/jellyseerr, *arr docker guides 2025–2026 |
| Stremio | stremio.com, Torrentio, AIOStreams/MediaFusion/Comet guides, Real-Debrid patterns |
| Our baseline | `/Users/husnainali/cinehome-sot` CINEHOME.md, overhaul design, stream-scraper |

---

## Bottom line for BOSS

- **Closest architectural peer:** **CinePro Core** (server multi-provider + proxy + TypeScript).  
- **Best UX to imitate in the player/browse chrome:** **movie-web / sudo-flix** (and LordFlix as already chosen).  
- **Best quality model we will not fully adopt:** **Stremio + debrid** / **Jellyfin Remux** — cherry-pick ranking UX and optional library/request hybrid only.  
- **VidLink:** keep as fast optional provider; treat crypto/WAF as perishable.  
- **Highest ROI steals:** BaseProvider + diagnostics, stream-row ranking, auto-failover, audio/sub in API, playable-only filter, multi-backend fan-in under one provider ID.

*End of research — 2026-07-09*
