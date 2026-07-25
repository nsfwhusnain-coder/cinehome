# CineHome Playback Bottlenecks — Research Report

| Field | Value |
|-------|-------|
| **Date** | 2026-07-09 |
| **Sources** | Local SoT `/Users/husnainali/cinehome-sot` + live container `cinehome` on hussyserver |
| **Scope** | Playback path only: scrape → resolve → proxy → player |
| **Files audited** | `hls-proxy.ts`, `video-player.tsx`, `source-quality.ts`, `stream-scraper/index.ts`, `use-playback.ts`, plus `scraper.ts`, `hls-session.ts`, HLS/playback API routes, auth, system-status |

---

## Executive summary

Playback is **architecturally playable** (progressive Luna-first resolve, in-process HLS proxy with LRU + prefetch, ABR caps, auto-upgrade Luna→Solstice). Residual pain is dominated by:

1. **Starting on slow CDN (Luna ~3s/seg)** until background enrich delivers Solstice/Pulse  
2. **Double-hop proxy** (browser → Next.js → CDN) with **auth+DB on every segment**  
3. **Watch-page full path always sends `nocache=1`**, which re-runs enrich (Playwright ~48s) whenever source count &lt; 12  
4. **Dead/slow providers** (Lordflix/Videasy 100% empty; VidLink often timeout) force Playwright  
5. **Browser pool leak** (live: 8 Chromiums, `MAX_BROWSERS=2`) wasting RAM on a co-tenant host  

Product TTFF is still **unmeasured** (scraper-only baseline exists: cold fast ~1485ms).

---

## Playback path (current)

```
Watch page
  → useWatchPlayback
      → GET /api/playback?fast=1     (Luna /prefetch, ~1–2s cold)
      → GET /api/playback?nocache=1  (full enrich; polls q12s up to 8× until ≥5 sources)
  → ScraperPlaybackProvider
      → createHlsSession + /api/hls/{session}?u=…
  → VideoPlayer (hls.js)
      → every manifest/segment: auth → fetchProxied → upstream CDN
```

Live health snapshot (2026-07-09):

| Provider | lastMs | lastOk | Notes |
|----------|--------|--------|-------|
| vixsrc (Luna) | 1116 | true | Fast path OK |
| notorrent (Pulse) | 532 | true | Fast API |
| vidlink | 10404 | **false** | timeout |
| lordflix | 715 | **false** | empty_result (enc-dec) |
| videasy | 517 | **false** | empty_result (enc-dec) |
| playwright | **48005** | true | Full embed fan-out ~48s |
| last full scrape | **52317ms** | — | movie:1339713 |
| pool | **8 browsers / max 2** | — | leak |

Baseline (docs/baseline-metrics.md, Witcher S1E1): cold fast **1485ms**, 1 source (Luna); warm after enrich **3 sources** (Luna, Solstice, Pulse).

---

## 1. Ranked bottlenecks (with evidence)

### B1 — Cold start stuck on Luna (slow CDN) until enrich  **Severity: CRITICAL (TTFF / stall)**

| | |
|--|--|
| **What** | Fast path returns **only Vixsrc/Luna**. Client starts playback immediately. Luna segment RTT documented as **~3.4s/seg** vs Solstice **~90–300ms**. Auto-upgrade to Solstice/Pulse only after full enrich + merge, and only if position &lt; 45s. |
| **Evidence** | `source-quality.ts:119–122, 176–193` (`isSlowCdnSource`, `isFasterSource`); `player-preferences.ts:6–7` (`DEFAULT_SOURCE_KEY = "Vidking\|Solstice"`); `stream-scraper/index.ts:1497–1507` (fast returns Luna + `scheduleBackgroundEnrich`); baseline A: 1 source Luna only; `video-player.tsx:504–519` (auto-upgrade). |
| **Impact** | First 5–60s of playback often ride the slow CDN; buffer stalls trigger downshift / failover. Dominant **perceived** lag after “Play”. |
| **Locations** | `mini-services/stream-scraper/index.ts` (fast path), `src/lib/playback/scraper.ts:159–171` (still **prefers Luna** for `streamUrl`), `src/lib/playback/source-quality.ts`, `src/components/video-player.tsx` auto-upgrade effect |

**Note:** Client `pickDefaultSource` ranks Solstice→Pulse→Luna correctly, but **fast response has no Solstice yet**. Server `ScraperPlaybackProvider` still forces Luna as default when present (`lunaEntry || …`), fighting client ranking on multi-source responses.

---

### B2 — Double-hop HLS proxy + per-segment auth/DB  **Severity: CRITICAL (steady-state bandwidth path)**

| | |
|--|--|
| **What** | Every segment/manifest: browser → Next route → `getAuthenticatedUserId()` → JWT session **+ Prisma `user.findUnique`** → `fetchProxied` → CDN → back through Next → browser. |
| **Evidence** | `src/app/api/hls/[sessionId]/route.ts:14–47`; `src/lib/auth.ts:101–118` (session + DB every call); `hls-proxy.ts:569–719` (always proxies). No segment path bypasses Node. |
| **Impact** | Adds server CPU, RTT, and memory bandwidth on every ~2–6s media fragment (and concurrent frag loads). On co-tenant laptop host, competes with scraper Chromium. Cache hits still pay auth+DB before cache lookup. |
| **Locations** | `src/app/api/hls/[sessionId]/route.ts`, `src/lib/auth.ts`, `src/lib/hls-proxy.ts` |

---

### B3 — Watch full-query always `nocache=1` while under 12 sources  **Severity: CRITICAL (server load / enrich storms)**

| | |
|--|--|
| **What** | `useWatchPlayback` full query **hardcodes** `noCache=true`. Scraper treats `nocache && !fast && sources.length < MAX_SOURCES(12)` as **synchronous re-enrich**. Typical titles have 2–4 sources → every full fetch re-runs APIs + Playwright. Full also **polls every 12s** up to 8 times until ≥5 sources. |
| **Evidence** | `use-playback.ts:164–182` (`fetchPlayback(..., false, true)`, `POLL_INTERVAL_MS=12_000`, `MAX_SOURCE_POLL_REFETCHES=8`); `stream-scraper/index.ts:1451–1478` (`bypassCache` / re-enrich); live full scrape **52s**. |
| **Impact** | Opening watch page can pin 1–2 Chromiums + network for ~50s; overlapping watches queue (`POOL_WAIT_TIMEOUT=120s`). Polling amplifies load. Starves concurrent users. |
| **Locations** | `src/hooks/use-playback.ts:164–182`, `mini-services/stream-scraper/index.ts:1437–1480` |

---

### B4 — Playwright embed path ~48s; only 2 intentional workers but pool leaks to 8  **Severity: HIGH**

| | |
|--|--|
| **What** | Fallback/enrich uses Playwright embeds (Vidking 25s budget, embed.su 18s, secondaries 15s) with `PW_WAIT_MS=110000`, `MAX_BROWSERS=2`. Live pool reports **8 browsers** (race: warm while in-use workers return browsers → length grows past max). |
| **Evidence** | `index.ts:28, 1214, 1224–1313, 738–793`; health `browsers:8, max:2`; last playwright **48005ms**. |
| **Impact** | Memory (~hundreds of MB per Chromium), CPU, slow multi-source availability. When Lordflix/Videasy dead, Playwright is the only path to Solstice. |
| **Locations** | `mini-services/stream-scraper/index.ts` (`warmBrowsers`, `withBrowser`, `playwrightFallback`, `buildSourceUrls`) |

---

### B5 — Provider reliability: Lordflix/Videasy dead; VidLink flaky  **Severity: HIGH (source diversity)**

| | |
|--|--|
| **What** | Lordflix + Videasy: circuit samples errorRate=1 (`empty_result` — enc-dec dependency). VidLink: last timeout 10.4s, errorRate 0.67. Working set: **Vixsrc + NoTorrent + Playwright(Vidking)**. |
| **Evidence** | Live `/health` circuits; STATUS.md / design doc; `resolveSecondaryApis` still awaits empty lordflix/videasy (up to 12s each in parallel with notorrent). |
| **Impact** | Wasted parallel time; fewer H264 HLS options; more failover to slow or broken URLs. Circuits exist but **have not opened** yet (need ≥6 samples @ ≥50% — currently 3 samples so still closed). |
| **Locations** | `providers/lordflix.ts`, `videasy.ts`, `vidlink-api.ts`, `providers/circuit.ts`, `index.ts:1144–1210` |

---

### B6 — Vixsrc resolve is multi-round-trip (~1.1–1.5s cold)  **Severity: MEDIUM (TTFF resolve phase)**

| | |
|--|--|
| **What** | Luna resolve: API JSON → embed HTML (token) → master playlist fetch → quality parse. Sequential, 10s timeouts. Baseline cold fast **1485ms**. |
| **Evidence** | `providers/vixsrc.ts:39–84`; baseline-metrics capture A. |
| **Impact** | Hard floor on cold “Play → have streamUrl” before first proxy hop. Cached scrape collapses this (~1ms). |
| **Locations** | `mini-services/stream-scraper/providers/vixsrc.ts`, `index.ts:1071–1091` |

---

### B7 — HLS verify probes (manifest + first segment) on enrich  **Severity: MEDIUM**

| | |
|--|--|
| **What** | `verifyHlsServer` / `filterVerifiedEntries` curl manifest + segment (`VERIFY_TIMEOUT_SEC=12`, up to 20s for HLS). Good for quality; adds multi-second cost to API providers on full path. |
| **Evidence** | `index.ts:539–576, 670–721`; `curl-http.ts` spawns **process per request** (tmpdir + curl). |
| **Impact** | Full enrich wall time; process spawn overhead vs native fetch for verify. |
| **Locations** | `mini-services/stream-scraper/index.ts`, `curl-http.ts` |

---

### B8 — Session-scoped segment cache (no cross-user / no share across rootUrl)  **Severity: MEDIUM**

| | |
|--|--|
| **What** | Cache key = `sha256(sessionId|url|range)`. Sessions are per `userId:rootUrl`. Two users (or two titles) never share bytes. Prefetch fills 8 segments per playlist rewrite. |
| **Evidence** | `hls-proxy.ts:64–66, 17–27, 178–226`; design KD11 intentional. |
| **Impact** | Correct for auth-bound CDNs, but household multi-watch same episode doubles upstream. Byte-cap 512MB + 2000 entries already shipped. |
| **Locations** | `src/lib/hls-proxy.ts`, `src/lib/hls-session.ts` |

---

### B9 — ABR / buffer policy is proxy-aware but may still over-fetch  **Severity: LOW–MEDIUM**

| | |
|--|--|
| **What** | Good: start ~480p, auto cap **720p**, ABR estimate 1.5 Mbps, maxBufferLength 30s, frag timeout 25s, stall downshift. Native Safari path has **no** equivalent caps. DASH path has no 720p auto cap. |
| **Evidence** | `video-player.tsx:45–63, 676–741, 601–647`. |
| **Impact** | Manual 1080p/4K still floods double-hop; Safari users can select high ladder freely. |
| **Locations** | `src/components/video-player.tsx` |

---

### B10 — Cache LRU implementation O(n) on touch/evict  **Severity: LOW**

| | |
|--|--|
| **What** | `cacheOrder` is an array; `removeFromOrder` uses `indexOf` + `splice` on every hit. |
| **Evidence** | `hls-proxy.ts:73–76, 94–105`. |
| **Impact** | Minor until cache full (2000); not primary TTFF issue. |

---

### B11 — Scraper result cache short for HLS (3 min)  **Severity: LOW–MEDIUM**

| | |
|--|--|
| **What** | `HLS_CACHE_TTL_MS = 3 * 60 * 1000` vs general 15m; signed URL expiry clamps further. Re-open after 3m re-resolves (good for signed URLs; bad for cold TTFF). |
| **Evidence** | `index.ts:33–36, 130–147`. |

---

## 2. Quick wins vs structural changes

### Quick wins (hours–1 day, high leverage)

| # | Change | Where | Why |
|---|--------|-------|-----|
| Q1 | **Stop hardcoding `nocache=true` on normal full enrich** — use nocache only on user Retry | `use-playback.ts:167` | Stops 52s re-enrich storms; rely on cache + `scheduleBackgroundEnrich` |
| Q2 | **Disable Lordflix/Videasy by default** (`PROVIDER_LORDFLIX=0`, `PROVIDER_VIDEASY=0`) or open circuit faster | env / `circuit.ts` thresholds | Cuts empty 0.5–12s work; already documented kill switches |
| Q3 | **Prefer Solstice/Pulse in `ScraperPlaybackProvider` default** (drop Luna bias; use same order as `pickDefaultSource`) | `scraper.ts:152–174` | Multi-source responses stop advertising Luna as `streamUrl` |
| Q4 | **Race NoTorrent (and early VidLink) into fast path** with short timeout (~1.5–2s) so Pulse can beat Luna at first paint | `index.ts` scrapeStream fast branch | Avoids slow-CDN first frame when Pulse is 500ms |
| Q5 | **Auth without DB on segment path** — JWT-only userId check; optional session cookie HMAC; cache session→userId in memory | `auth.ts` + HLS route | Removes Prisma hit per fragment |
| Q6 | **Cap browser pool hard** — never `push` if `length >= MAX_BROWSERS`; close extras | `withBrowser` / `warmBrowsers` | Fix 8→2 Chromiums immediately |
| Q7 | **Lower full poll aggressiveness** — poll only while `partial` and enrichingKeys equivalent; stop at 3 sources if Solstice+Pulse present | `use-playback.ts` | Fewer full scrapes |
| Q8 | **Skip verify on known-good providers** (Vixsrc already trusted; NoTorrent optional) or parallelize with lower timeout | `index.ts` | Shorter enrich |

### Structural (days–week+, larger design)

| # | Change | Tradeoff |
|---|--------|----------|
| S1 | **Direct CDN to client when CORS+hotlink allow** (proxy only when required) | Complexity, SSRF, cookie/referer handling; biggest RTT win |
| S2 | **Edge/sidecar segment proxy** (Caddy, dedicated Bun worker) with shared disk cache keyed by content hash | Ops; better multi-user share; still double-hop but not Next |
| S3 | **Parallel first-class Solstice API** without Playwright (if reverse-engineerable) | Maintenance when embed changes |
| S4 | **Self-host / replace enc-dec** for Lordflix/Videasy | Provider churn |
| S5 | **Shared (not session-only) segment cache** with auth re-check on miss only | Security review vs KD11 |
| S6 | **Measure product TTFF** (Play → `playing`) in harness | Unblocks real targets ≤8s cold / ≤3s warm |

---

## 3. Already fixed vs still broken

### Already fixed / shipped (do not rebuild)

| Item | Evidence |
|------|----------|
| Curl-per-segment gone; native `fetch` proxy | `hls-proxy.ts` entire file; design doc claims verified |
| Entry LRU + **byte-cap 512MB** + hit/miss metrics + system-status | `SEGMENT_CACHE_MAX_BYTES`, `getProxyMetrics`, `/api/system-status` |
| Segment **prefetch 8** (design doc still says 3 — **stale**) | `PREFETCH_SEGMENT_COUNT = 8` |
| Stream response (clone + cache async) for segments | `hls-proxy.ts:679–699` |
| Luna-first fast path + background enrich | scraper `scrapeStream` + `/prefetch` |
| Progressive dual-query client merge | `useWatchPlayback` / `mergePlaybackResponses` |
| Soft-miss / partial flags | fast empty → `partial: true`; client `isSoftMiss` |
| Source ranking prefers H264 HLS, demotes HEVC/DASH | `source-quality.ts`, scraper `scoreSourceEntry` |
| Client default key Solstice; failover priority Solstice→Pulse→Luna | `player-preferences.ts`, `sourceFailoverPriority` |
| Auto-upgrade Luna→fast CDN once, early (&lt;45s) | `video-player.tsx:504–519` |
| hls.js proxy-friendly buffers, 480p start, **720p auto cap**, stall downshift | `video-player.tsx` constants + handlers |
| Session reuse `getOrCreateHlsSession` | `hls-session.ts` |
| Circuit breakers + kill switches + `/health` circuits | `providers/circuit.ts`, CINEHOME.md |
| Smoke harness + cold baseline 1485ms | `scripts/smoke-playback.ts`, `docs/baseline-metrics.md` |
| Season next-ep rollover | `watch.tsx:resolveNextEpisode` |
| Retry full (`retryFull` resets queries) | `use-playback.ts` |

### Still broken / residual

| Item | Status |
|------|--------|
| **Cold watch starts on Luna slow CDN** | Still dominant UX lag |
| **`useWatchPlayback` full always nocache** | Still broken; causes re-enrich storms |
| **Lordflix/Videasy 0 streams** | Still broken (enc-dec) |
| **VidLink timeouts** | Frequent |
| **Playwright pool leak (8 &gt; max 2)** | Live bug |
| **Per-segment Prisma auth** | Still on hot path |
| **Server default still Luna-biased** | `scraper.ts` lunaEntry preference |
| **Product TTFF unmeasured** | Only scraper marks |
| **Safari/native ABR uncapped** | Still |
| **DASH ABR uncapped** | Still |
| **Circuit open threshold slow to trip** (need 6 samples) | Lordflix still “closed” at 100% error with 3 samples |
| Design doc drift | Says byte-cap missing / prefetch 3 / MIN_SOURCES 5 — code has byte-cap, prefetch 8, MIN_SOURCES 8 |

---

## 4. Exact code locations to change

### Hot path — prioritize

| Priority | File | Lines / symbol | Suggested edit |
|----------|------|--------------|----------------|
| P0 | `src/hooks/use-playback.ts` | `useWatchPlayback` full `queryFn` ~L167 | Change `fetchPlayback(..., false, true)` → `false` (no nocache). Pass `true` only from `retryFull`. |
| P0 | `src/hooks/use-playback.ts` | `refetchInterval` ~L172–182 | Stop polling when Solstice/Pulse present or `!partial`; reduce max refetches. |
| P0 | `mini-services/stream-scraper/index.ts` | `scrapeStream` fast branch ~L1497–1507 | Optionally race `resolveNotorrent` (2s) into fast response before return. |
| P0 | `mini-services/stream-scraper/index.ts` | `withBrowser` / `warmBrowsers` ~L738–793 | Hard cap pool; close surplus browsers. |
| P1 | `src/lib/playback/scraper.ts` | `lunaEntry` / `defaultEntry` ~L152–174 | Align with `pickDefaultSource` / Solstice-first (remove Luna hard preference). |
| P1 | `src/lib/auth.ts` + `src/app/api/hls/[sessionId]/route.ts` | `getAuthenticatedUserId` | JWT-only id for HLS; skip DB or memoize by token exp. |
| P1 | `src/lib/playback/source-quality.ts` | already good ranking | Keep; ensure all callers use it (not scraper lunaEntry). |
| P1 | env / docker-compose | `PROVIDER_LORDFLIX=0`, `PROVIDER_VIDEASY=0` | Kill dead providers in prod. |
| P2 | `mini-services/stream-scraper/providers/circuit.ts` | open thresholds | Open earlier for 100% empty providers (e.g. min samples 3). |
| P2 | `mini-services/stream-scraper/index.ts` | `filterVerifiedEntries` / verify timeouts | Skip or soft-verify Pulse/Luna; lower VERIFY_TIMEOUT. |
| P2 | `src/components/video-player.tsx` | DASH settings ~L619–647; native HLS ~L828–842 | Apply height caps analogous to HLS_AUTO_MAX_HEIGHT. |
| P2 | `src/lib/hls-proxy.ts` | `removeFromOrder` | Linked-list / Map for O(1) LRU (optional). |
| P2 | `src/lib/hls-proxy.ts` | auth order vs cache | Consider cache check before expensive work (still need session). |
| P3 | `src/components/video-player.tsx` | `AUTO_UPGRADE_MAX_POSITION_S` | If enrich late, allow one upgrade slightly later or toast “Faster server available”. |
| P3 | `scripts/smoke-playback.ts` + docs | — | Add optional authenticated TTFF later (PR-05). |

### Key constants (current values)

| Constant | Value | File |
|----------|-------|------|
| `PREFETCH_SEGMENT_COUNT` | 8 | `hls-proxy.ts:23` |
| `SEGMENT_CACHE_MAX` / `MAX_BYTES` | 2000 / 512MB | `hls-proxy.ts:17–21` |
| `UPSTREAM_TIMEOUT_MS` | 30s | `hls-proxy.ts:27` |
| `SESSION_TTL_MS` | 25m | `hls-session.ts:18` |
| `HLS_START_HEIGHT` / `HLS_AUTO_MAX_HEIGHT` | 480 / 720 | `video-player.tsx:56–58` |
| `HLS_MAX_BUFFER_LENGTH_S` | 30 | `video-player.tsx:49` |
| `POLL_INTERVAL_MS` / max refetches | 12s / 8 | `use-playback.ts:53–54` |
| `FAST_FETCH_TIMEOUT_MS` / full | 20s / 130s | `scraper.ts:9–10` |
| `MAX_BROWSERS` | 2 (live pool 8) | scraper `index.ts:28` |
| `MAX_SOURCES` / `MIN_SOURCES_TARGET` | 12 / 8 | scraper `index.ts:38–40` |
| `HLS_CACHE_TTL_MS` | 3m | scraper `index.ts:36` |
| `PW_WAIT_MS` | 110s | scraper `index.ts:1214` |
| `VIXSRC_TIMEOUT_MS` | 10s | scraper `index.ts:34` |
| `DEFAULT_SOURCE_KEY` | `Vidking\|Solstice` | `player-preferences.ts:7` |

### Call graph (resolve → play)

```
useWatchPlayback
  fetchPlayback fast  → GET /api/playback?fast=1
  fetchPlayback full  → GET /api/playback?nocache=1   ← Q1 target
    → getProvider() → ScraperPlaybackProvider.resolve
         → scrape /prefetch or /scrape
         → createHlsSession per source
         → streamUrl prefers Luna              ← P1 target
  mergePlaybackResponses + pickDefaultSource   (client Solstice-first)
VideoPlayer activeSource
  hls.js → /api/hls/:id?u=…
    getAuthenticatedUserId (JWT+DB)            ← P1 target
    fetchProxied (cache / upstream / rewrite)
```

---

## 5. Recommended attack order for next coding session

1. **Q1 + Q7** — kill nocache-on-every-watch and over-polling (server relief, minutes of work).  
2. **Q6** — fix browser pool leak (live 8 Chromiums).  
3. **Q2** — env-disable Lordflix/Videasy.  
4. **Q3 + Q4** — Solstice/Pulse earlier in default + fast path race.  
5. **Q5** — strip DB from HLS auth.  
6. Measure once: cold/warm **product TTFF** Witcher S1E1 after 1–5.  
7. Only then consider S1/S2 structural proxy changes.

---

## 6. Out of scope / non-findings

- UI/nav/design system issues (`plan.md`) — not playback latency.  
- Curl-per-segment rewrite — **already done**.  
- Greenfield progressive playback — **already shipped**.  
- Git SoT hygiene — ops, not TTFF.  

---

## Appendix — Live evidence snippets

**Health (abbreviated):** vixsrc ok 1116ms; notorrent ok 532ms; vidlink fail 10404ms; lordflix/videasy empty; playwright ok 48005ms; pool size 8 max 2; last full scrape 52317ms.

**Baseline:** cold fast scrape_fast_ms ≈ 1485, sources=1 Luna; warm sources=3 Luna+Solstice+Pulse.

**SoT ↔ server:** `hls-proxy.ts` 724 LOC, prefetch 8, byte-cap present — matches local SoT for core playback files audited.
