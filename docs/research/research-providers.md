# Stream Provider Research for CineHome
**Date:** 2026-07-09  
**Scope:** Household self-hosted cinema only — no public redistribution  
**Problem:** Default Luna (Vixsrc) CDN segments ~3.4s; Vidking segments ~100ms. Need better/faster multi-provider sources.

---

## Legal note

This research is for a **personal / household self-hosted** app (CineHome). Providers listed below are third-party scrapers/aggregators that resolve publicly available links; they do **not** host content. Upstream sites are frequently taken down, blocked, or litigated (e.g. VidSrc / studio actions). Run only on your LAN; do not expose scrapers publicly. You are responsible for compliance with local law. Nothing here is legal advice.

---

## 0. CineHome current state (baseline)

| Source | Path in app | Resolve method | CDN / delivery | Seg latency (observed) |
|--------|-------------|----------------|----------------|------------------------|
| **Vidking** (“Solstice”) | Playwright embed `vidking.net` | Browser capture of m3u8 | Fast edge (CDN-class hosts; segments e.g. `infantinostreet…`) | **~100 ms/seg** |
| **Vixsrc / Luna** | `providers/vixsrc.ts` | Pure HTTP API → tokenized master m3u8 | Custom signed playlist CDN (`token`+`expires`) | **~3.4 s/seg** (buffering) |
| **Videasy** | `providers/videasy.ts` + enc-dec | 10 servers via `api.videasy.net` + `enc-dec.app` | Mixed (depends on server: cdn / moviebox / 1movies…) | Variable; often better than Luna |
| **Vidlink** | `vidlink-api.ts` | API (enc-dec for some paths) | Mixed HLS | Variable |
| **Lordflix / NoTorrent** | providers/ | enc-dec / Stremio addon | Mixed / torrent-adjacent | Variable |

**Key insight:** Vidking and Videasy share the same family (`enc-dec.app` docs list `vidking.net` as an alternative domain of **videasy.to**). Prefer API resolve of Videasy “cdn” / fast servers over Playwright when possible; keep Vidking embed as proven fallback.

---

## 1. Active open-source multi-provider aggregators (2024–2026)

### A. CinePro Core — **most relevant / actively maintained**
| | |
|--|--|
| **Repo** | https://github.com/cinepro-org/core (~123★, May 2026 releases) |
| **Docs** | https://docs.cinepro.cc |
| **Spec** | OMSS: https://github.com/omss-spec/omss-spec |
| **Stack** | TypeScript, Docker (`ghcr.io/cinepro-org/core`), Redis cache |
| **License** | PolyForm Noncommercial 1.0 — personal/home only |
| **Providers dir** | `src/providers/`: videasy, vixsrc, vidsrc, vidzee, anyembed, streammafia, fmovies4u, icefy, peachify, popr, tulnex, vidapi, vidnest, vidrock, cinesu, fshare, 02moviedownloader |
| **API** | OMSS: `GET /v1/movies/{tmdbId}`, `GET /v1/tv/{id}/seasons/{s}/episodes/{e}` → proxied HLS/MP4 |
| **Auth** | `TMDB_API_KEY` env only (no provider keys) |
| **Note** | Explicit **CineHome integration planned late 2026**; Stremio addon + MCP support |

**How to call (self-host):**
```bash
docker run -p 3000:3000 -e TMDB_API_KEY=YOUR_KEY ghcr.io/cinepro-org/core:latest
# Movie sources:
curl -s "http://localhost:3000/v1/movies/550"
# TV:
curl -s "http://localhost:3000/v1/tv/1399/seasons/1/episodes/1"
# Stream URLs come as /v1/proxy?data=... (header-forwarding proxy)
```

---

### B. TMDB-Embed-API — **best pluggable provider reference**
| | |
|--|--|
| **Repo** | https://github.com/Inside4ndroid/TMDB-Embed-API (~121★, v1.1.1 May 2026) |
| **Docker** | `inside4ndroid/tmdb-embed-api:latest` port **8787** |
| **Active providers (1.1.1)** | showbox/febbox, 4khdhub, **vixsrc**, **videasy** (enc-dec), **vidlink** (enc-dec), **lordflix** (enc-dec), notorrent, dahmermovies |
| **Removed (dead)** | MoviesMod, VidZee, MP4Hydra, UHDMovies, Vidsync, Xprime, MoviesClub |
| **Auth** | TMDB key(s); optional FebBox JWT cookie for Showbox; admin UI login |
| **Proxy** | Optional `/m3u8-proxy`, `/ts-proxy` with range clamp + tail prefetch |

**How to call:**
```bash
# Aggregate
curl "http://localhost:8787/api/streams/movie/550"
# Single provider
curl "http://localhost:8787/api/streams/videasy/movie/550"
curl "http://localhost:8787/api/streams/vixsrc/movie/550"
curl "http://localhost:8787/api/streams/4khdhub/movie/550"
```

**Stream object shape:**
```json
{
  "title": "Fight Club - 1080p [Videasy Neon]",
  "url": "https://….m3u8",
  "quality": "1080p",
  "provider": "videasy",
  "headers": { "Referer": "…", "User-Agent": "…" }
}
```

---

### C. enc-dec.app — **crypto relay (not a stream host)**
| | |
|--|--|
| **Service** | https://enc-dec.app |
| **Docs/repo** | https://github.com/smy778/EncDecEndpoints |
| **Rate limit** | 40 req/s |
| **Role** | Encrypt/decrypt blobs for Videasy, Vidlink, Lordflix, Vidfast, Vidcore, YFlix, AnimeKai, Hexa, FlixCloud, MegaUp, etc. Does **not** stream video. |

**Endpoints relevant to CineHome:**

| Provider | Endpoint | Method |
|----------|----------|--------|
| Videasy / Vidking | `POST https://enc-dec.app/api/dec-videasy` body `{ "text": "<blob>", "id": "<tmdbId>" }` | Decrypt |
| Vidlink | `GET https://enc-dec.app/api/enc-vidlink?text=<tmdbId>` | Encrypt ID |
| Lordflix | `GET …/enc-lordflix?url=…` + `POST …/dec-lordflix` | Enc+Dec |
| Vidfast | `GET …/enc-vidfast` + `POST …/dec-vidfast` | Enc+Dec |
| Vidcore | `GET …/enc-vidcore` + `POST …/dec-vidcore` | Enc+Dec |
| YFlix / 1movies | `GET …/enc-movies-flix` + `POST …/dec-movies-flix` | Enc+Dec |
| Cinesrc | `GET …/enc-cinesrc` + `POST …/dec-cinesrc` | Enc+Dec |

CineHome already wraps these in `providers/enc-dec.ts`.

---

### D. Consumet — **largely dead for movies (2026-07)**
| | |
|--|--|
| **Org** | https://github.com/consumet |
| **Lib** | https://github.com/consumet/consumet.ts |
| **API** | https://github.com/consumet/api.consumet.org |
| **Status** | https://github.com/consumet/providers-status |

**Movies status as of 2026-07-09:** **all red** — FlixHQ, Fmovies, Goku, HiMovies, SFlix, Smashystream, DramaCool, Turkish123 all **HTTP 500**.  
**Do not rely on Consumet for CineHome movie streams.** Anime/manga meta still partially alive.

---

### E. movie-web / P-Stream / sudo-flix lineage
| | |
|--|--|
| **@movie-web/providers (fork)** | https://github.com/sussy-code/providers · docs https://sussy-code.github.io/providers/ |
| **P-Stream** | https://github.com/p-stream — **archived May 2026** (providers often closed-source) |
| **FlixQuest API** | https://github.com/BeamlakAschalew/flixquest-api — REST over `@movie-web/providers` + TMDB |
| **Status** | Upstream movie-web shutdown years ago; forks fragile; P-Stream “#1 on FMHY” then shut down |

Useful as reference scrapers, not as a stable dependency.

---

### F. VidSrc extractors / bypass tools
| Repo | Notes |
|------|--------|
| https://github.com/cool-dev-guy/vidsrc.ts | Successor to vidsrc-api; vidsrc.to dead |
| https://github.com/heyitswit/vidsrc-bypass | Archived 2024; embed.su / vidlink.pro / vidsrc.icu patterns |
| https://github.com/DivineChile/vidsrc-scraper | Playwright multi-domain HLS extract |
| https://github.com/parnexcodes/2embed-api | Old 2embed HLS API — often broken |

Streambert (https://github.com/truelockmc/streambert) wraps VidSrc + 2Embed for desktop; legal risk same as VidSrc.

---

## 2. Direct m3u8 vs embed — CDN characteristics

| Provider | Returns direct playable URL? | Needs enc-dec.app? | Typical delivery | CDN class | Notes for buffering |
|----------|------------------------------|--------------------|------------------|-----------|---------------------|
| **Vidking** | Yes (m3u8 after embed/API) | Optional (same family as Videasy) | HLS segments on edge hosts | **Fast** (CF-class / edge) | **Best measured ~100ms/seg** |
| **Videasy `cdn` / Yoru** | Yes (m3u8/mp4 after decrypt) | **Yes** `dec-videasy` | Named “cdn” server | **Usually fast** | Prefer over Luna |
| **Videasy other servers** | Yes | **Yes** | Mixed hosters | Variable | Parallel fan-out; pick best |
| **Vixsrc / Luna** | Yes master m3u8 + tokens | **No** pure HTTP | Signed playlist on custom CDN | **Slow** (~3.4s/seg) | Token expiry; referer required |
| **Vidlink.pro** | Yes HLS playlist | **Yes** `enc-vidlink` | Single playlist | Medium | Simple one-shot |
| **Lordflix** | Yes | **Yes** enc+dec | Multi-server (Berlin etc.) | Medium | Domain hop: snowhouse.lordflix.club |
| **Showbox / FebBox** | Direct file / progressive MP4 often | **No** (needs **FebBox JWT cookie**) | Regional OSS (`oss_group=USA7`…) | **Often fast** for progressive | Cookie + region; CF challenges historically |
| **4KHDHub** | Direct MP4/file links | **No** pure HTTP scrape | Pixeldrain, HubCloud, S3, FSL; **blocks r2.dev** | Pixeldrain **trusted/fast** | Not always HLS; good quality 4K |
| **NoTorrent** | Stremio stream objects | No | Addon API | Depends on magnet/debrid | Not pure CDN VOD |
| **DahmerMovies** | Direct file links | No | Open directory | Variable | Needs proxy rewrite |
| **Embed.su / 2embed / vidsrc.\*** | Embed iframe first | Often custom decrypt | Player iframe + ads | Mixed / often slow | Prefer direct extractors |
| **FlixHQ / SFlix (Consumet)** | Would be m3u8 | No | Classic stream sites | N/A | **Offline/failing mid-2026** |

### CDN heuristics (when choosing among returned URLs)

Prefer streams whose hostnames look like:
- Cloudflare / Bunny / major edge (`*.cloudflarestream.com`, bunny pull zones, `cdn.*`, short TTFB)
- Pixeldrain API file URLs (`pixeldrain.net/api/file/…`) for progressive
- Videasy “cdn” / “mb-flix” / “superflix” after decrypt

Deprioritize:
- Vixsrc tokenized masters (known slow for CineHome)
- Hosts with heavy challenge pages / single-origin shared hosting
- `.zip` archives, HEVC-only when client is H.264-first
- `r2.dev` FSL links (blocked in TMDB-Embed-API policy)

---

## 3. enc-dec.app dependency matrix

| Works with pure HTTP/API only | Needs enc-dec.app (or equivalent closed crypto) |
|-------------------------------|--------------------------------------------------|
| **Vixsrc** (`vixsrc.to/api/…` + HTML token parse) | **Videasy / Vidking API** (`dec-videasy`) |
| **4KHDHub** (HTML scrape + redirects) | **Vidlink** (`enc-vidlink`) |
| **Showbox/FebBox** (cookie + form POST) | **Lordflix** (enc+dec) |
| **NoTorrent** (Stremio addon HTTP) | **Vidfast, Vidcore, YFlix, Cinesrc, Hexa** |
| **CinePro Core** (internal decryptors; may still call enc-dec in some providers) | **FlixCloud, MegaUp, Abyss** hosters |
| **DahmerMovies** | |

**CineHome already has** `providers/enc-dec.ts` — keep it for Videasy/Lordflix; do not hardcode AES (VidZee style salts break often — TMDB-Embed removed VidZee for this).

---

## 4. Latency characteristics (documented / observed)

| Source | Metric | Value | Confidence |
|--------|--------|-------|------------|
| **CineHome Vidking** | HLS segment fetch | **~100 ms** | High (user measurement) |
| **CineHome Vixsrc/Luna** | HLS segment fetch | **~3400 ms** | High (user measurement) |
| **Consumet** | Provider response (movies) | All **500 / N/A** | High (status page 2026-07-09) |
| **Consumet** | Working meta (TMDB) | **~0.18 s** API only | High |
| **Bunny CDN** (general) | Median TTFB NA (static) | **~28 ms** | Industry benchmark (not pirate CDN) |
| **enc-dec.app** | Rate limit | **40 rps** | Documented |
| **Vixsrc tokens** | Playlist signed `expires` | Short-lived; cache ≤ expiry−60s | From provider code |
| **CineHome HLS cache** | `HLS_CACHE_TTL_MS` | **3 min** | App code |

**No public benchmark** publishes “ms/segment” for Videasy servers or FebBox; treat multi-server parallel + first-byte race as the practical latency strategy.

---

## 5. Ranked recommendations for CineHome (TOP 5)

### Rank 1 — **Videasy multi-server API (esp. `cdn` / mb-flix / superflix)**  
**Why:** Same family as proven-fast **Vidking**; returns **direct m3u8/mp4**; already partially integrated; 6–10 servers in parallel; CinePro prioritizes these too.

**How to call (already in CineHome pattern):**
```http
GET https://api.videasy.net/cdn/sources-with-title?title=Fight+Club&mediaType=movie&year=1999&tmdbId=550&imdbId=tt0137523
Headers:
  Origin: https://player.videasy.net
  Referer: https://player.videasy.net/
  User-Agent: Mozilla/5.0 …
→ body: encrypted hex/text blob

POST https://enc-dec.app/api/dec-videasy
Content-Type: application/json
{ "text": "<blob>", "id": "550" }
→ { "result": { "sources": [ { "url": "https://….m3u8", "quality": "1080p" } ], "subtitles": [] } }
```

**CinePro server list (more current than old Neon/Yoru names):**
- `https://api.videasy.net/mb-flix/sources-with-title`
- `https://api.videasy.net/cdn/sources-with-title`
- `https://api.videasy.net/1movies/sources-with-title`
- `https://api.videasy.net/superflix/sources-with-title`
- `https://api.videasy.net/lamovie/sources-with-title`
- `https://api2.videasy.net/cuevana/sources-with-title`

**Integration tips:**
1. Race servers; **score by first segment TTFB**, not just resolve success.
2. Prefer `.m3u8` + non-HEVC for Apple TV / Safari clients.
3. Attach `Referer/Origin: player.videasy.net` on proxy.
4. Align SERVERS map with CinePro (drop dead Neon/Breach endpoints).

---

### Rank 2 — **Vidking embed / API (keep as gold standard speed)**  
**Why:** Empirically fastest for CineHome (~100ms/seg). Alternate domain of Videasy.

**Embed (current Playwright path):**
```
https://www.vidking.net/embed/movie/{tmdbId}
https://www.vidking.net/embed/tv/{tmdbId}/{season}/{episode}
```

**API path (prefer over Playwright when stable):**
- Same as Videasy decrypt; docs: `api.videasy.to` / `api.wingsdatabase.com` + `dec-videasy`.

**Integration tips:**
- Keep Playwright only as fallback when API decrypt fails.
- Cache captured m3u8 + cookie/session ≤ 3–15 min (already in `stream-scraper`).
- When ranking sources, **boost any host that matches Vidking segment host patterns** after probe.

---

### Rank 3 — **Self-host CinePro Core as upstream aggregator**  
**Why:** OMSS-standard multi-provider backend; explicit CineHome roadmap; Docker one-liner; proxy handles Referer; 50+ sources design; active 2026 maintenance.

**How to call:**
```bash
# docker-compose service next to stream-scraper
TMDB_API_KEY=…
curl "http://cinepro:3000/v1/movies/550"
# Play via
# http://cinepro:3000/v1/proxy?data=<urlencoded json url+headers>
```

**Integration tips:**
- Point CineHome “source resolve” at CinePro instead of reimplementing every scraper.
- Disable/deprioritize CinePro’s **vixsrc** provider if still slow.
- Use CinePro proxy URLs as session.referer-aware HLS inputs.
- License is noncommercial — fine for household.

---

### Rank 4 — **Vidlink.pro (simple single HLS + enc-dec)**  
**Why:** Already in CineHome (`vidlink-api.ts`); low code complexity; pure JSON after encrypt step.

**How to call:**
```http
GET https://enc-dec.app/api/enc-vidlink?text=550
→ { "result": "<encoded>" }

GET https://vidlink.pro/api/b/movie/<encoded>?multiLang=0
Headers: Referer: https://vidlink.pro
→ { "stream": { "playlist": "https://….m3u8" } }

# TV:
GET https://vidlink.pro/api/b/tv/<encoded>/{season}/{episode}?multiLang=0
```

**Integration tips:**
- Probe segment TTFB; if slow, demote below Videasy.
- One playlist only — good backup, not multi-quality picker.

---

### Rank 5 — **4KHDHub + Pixeldrain (quality / progressive, pure HTTP)**  
**Why:** No enc-dec; high-bitrate files; Pixeldrain is trusted/fast in extractor code; good when HLS sources fail or quality is low.

**How to call (via TMDB-Embed-API or port extractor):**
```http
GET http://localhost:8787/api/streams/4khdhub/movie/550
# or scrape 4khdhub domain list from:
# https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json
```

**Delivery:** Direct MP4-style links (Pixeldrain `api/file/{id}`, HubCloud, S3, “10Gbps” redirects). **Not always HLS** — client must support progressive / Range requests (CineHome proxy already has range logic ideas via TMDB-Embed).

**Integration tips:**
- Prefer Pixeldrain URLs in ranking.
- Skip `.zip` and blocked `r2.dev`.
- Better as “quality” source than primary live TV binge if seek is heavy.

---

### Honorable mentions (not top 5)

| Provider | Use when | Caveat |
|----------|----------|--------|
| **Showbox/FebBox** | Want regional progressive files | Needs **FebBox JWT**; CF bot walls come and go |
| **Lordflix** | Extra servers via enc-dec | Medium reliability; domain changes |
| **NoTorrent / Stremio addons** | Debrid/torrent household setup | Not pure CDN VOD latency |
| **Consumet FlixHQ etc.** | — | **Broken 2026-07** |
| **2embed / classic vidsrc embeds** | Legacy iframe only | Ads, unstable, legal heat |

---

## 6. Concrete CineHome integration plan (priority order)

### Immediate (this week)
1. **Deprioritize Vixsrc/Luna** in source ranking (score −100 or last resort only).
2. **Refresh Videasy SERVERS** to CinePro’s list (`mb-flix`, `cdn`, `superflix`, `1movies`, `lamovie`, `cuevana`); drop dead endpoints.
3. After resolve, **probe first segment TTFB** (HEAD or 1-range GET, 2s timeout) and sort by latency before return.
4. Prefer streams with hostname patterns matching historical Vidking-fast CDN.

### Short term
5. Add **CinePro Core** as optional Docker dependency; map OMSS sources → CineHome `SourceEntry`.
6. Keep **Vidking Playwright** as reliability fallback only.
7. Optional: stand up **TMDB-Embed-API** for 4khdhub/showbox without rewriting scrapers.

### Ranking algorithm suggestion
```
score = 0
+100 if provider in {Vidking, Videasy} and ttfb_ms < 300
+80  if label/server in {cdn, Yoru, mb-flix, superflix, Solstice}
+40  if .m3u8 && !hevc
+25  if quality >= 1080
-100 if provider == Vixsrc || label == Luna
-50  if ttfb_ms > 1500
-40  if hevc-only
-30  if progressive only && client prefers HLS
```

### Do not
- Depend on public Consumet instances for movies.
- Publicly expose stream-scraper / CinePro without auth (abuse + legal).
- Hardcode AES salts for providers that rotate crypto (use enc-dec.app).

---

## 7. Endpoint cheat sheet

| Goal | Call |
|------|------|
| Videasy CDN blob | `GET https://api.videasy.net/cdn/sources-with-title?title=&mediaType=&year=&tmdbId=&imdbId=` |
| Decrypt Videasy | `POST https://enc-dec.app/api/dec-videasy` `{"text","id"}` |
| Vidlink encrypt | `GET https://enc-dec.app/api/enc-vidlink?text={tmdb}` |
| Vidlink movie | `GET https://vidlink.pro/api/b/movie/{enc}?multiLang=0` |
| Vixsrc movie | `GET https://vixsrc.to/api/movie/{tmdb}` → embed HTML → master+token |
| Vidking embed | `https://www.vidking.net/embed/movie/{tmdb}` |
| CinePro movie | `GET http://localhost:3000/v1/movies/{tmdb}` |
| TMDB-Embed agg | `GET http://localhost:8787/api/streams/movie/{tmdb}` |
| Provider status (Consumet) | https://github.com/consumet/providers-status |

---

## 8. Repos index (2024–2026)

| Project | URL | Stars / activity | Role |
|---------|-----|------------------|------|
| CinePro Core | https://github.com/cinepro-org/core | ~123★, active 2026 | Multi-provider OMSS backend |
| TMDB-Embed-API | https://github.com/Inside4ndroid/TMDB-Embed-API | ~121★, v1.1.1 | Provider plugins + proxy |
| EncDecEndpoints | https://github.com/smy778/EncDecEndpoints | ~60★ | Crypto relay docs |
| consumet.ts | https://github.com/consumet/consumet.ts | Mature but movie providers down | Anime-oriented |
| sussy-code/providers | https://github.com/sussy-code/providers | movie-web fork | Scrape lib |
| FlixQuest API | https://github.com/BeamlakAschalew/flixquest-api | Smaller | REST over movie-web providers |
| vidsrc.ts | https://github.com/cool-dev-guy/vidsrc.ts | Active lineage | VidSrc extractor |
| OMSS | https://github.com/omss-spec/omss-spec | Spec | Interop standard |
| P-Stream | https://github.com/p-stream | Archived 2026 | Historical |

---

## 9. Bottom line for buffering fix

| Action | Expected impact |
|--------|-----------------|
| Stop preferring Luna/Vixsrc | Removes ~3.4s/seg path from default |
| Prefer Vidking + Videasy `cdn`/`mb-flix` | Stays on ~100ms class CDNs |
| Segment TTFB race across providers | Auto-picks fastest host per title |
| Add CinePro as aggregator | More sources without more scrapers |
| 4KHDHub/Pixeldrain as quality fallback | When HLS weak / missing |

**Primary code touchpoints in CineHome:**
- `/Users/husnainali/cinehome-app/mini-services/stream-scraper/providers/videasy.ts` — server list + scoring  
- `/Users/husnainali/cinehome-app/mini-services/stream-scraper/providers/vixsrc.ts` — demote Luna  
- `/Users/husnainali/cinehome-app/mini-services/stream-scraper/index.ts` — merge/rank + optional CinePro client  

---

*Research compiled for household self-host CineHome only. Upstream sites change frequently; re-validate endpoints before shipping.*
