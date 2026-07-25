# HLS Proxy Architecture Research

**Context:** Browser (LAN/Tailscale) → home-server Next.js HLS proxy (header inject + m3u8 rewrite) → Luna CDN  
**Pain:** Double hop + ~3.4s/segment upstream + required `Referer` injection → buffering  
**Date:** 2026-07-09  

---

## Research findings (questions 1–6)

### 1. Can the browser fetch CDN segments DIRECTLY with custom headers?

**Short answer: No — not for a third-party CDN that requires a spoofed `Referer`.**

| Mechanism | What it can do | What it cannot do |
|-----------|----------------|-------------------|
| hls.js `xhrSetup` | Set non-forbidden headers (`Authorization`, `X-*`) on XHR | Set `Referer`, `Origin`, `Host`, `Cookie` arbitrarily |
| hls.js `fetchSetup` | Same via `Request` init | Same forbidden-header rules |
| CORS | Allows *reading* cross-origin responses if CDN opts in | Does not let you invent request headers the UA forbids |

**Forbidden request headers (Fetch spec):** include `Referer`, `Origin`, `Host`, `Cookie`, and others. Spec-compliant browsers (and service workers using Fetch) **cannot** set `Referer` to an arbitrary third-party URL. `fetch({ referrer })` only allows same-origin referrers or empty.

**CORS preflight:** Any custom non-safelisted header → `OPTIONS` preflight. CDN must return:

- `Access-Control-Allow-Origin: <your origin or *>`
- `Access-Control-Allow-Headers: <those headers>`

Luna-style CDNs that gate on `Referer` typically:

1. Expect server-side spoofing (not browser-controlled).
2. Often omit CORS for arbitrary web origins (or only allow their own player origin).
3. Return 403 without the expected `Referer`/`Origin`/`User-Agent` combo.

**hls.js CORS requirement:** All HLS resources must allow CORS GET for MSE-based playback. Even if the CDN were public, missing `Access-Control-Allow-Origin` blocks segment use in hls.js (native Safari HLS is more lenient for `<video src>` but still won’t let JS forge `Referer`).

**Implication for your stack:** Segments that require `Referer` **must** be fetched by a non-browser agent (home proxy, edge worker with full header control, nginx, etc.). Browser-direct is a dead end for Luna-class protection.

---

### 2. Worker / service-worker proxy patterns

#### A. Browser Service Worker (client-side)

**Pattern (Mux and others):** SW intercepts playlist/segment requests, rewrites m3u8 text, optionally caches segments in Cache API.

| Pro | Con |
|-----|-----|
| No server hop for *same-origin* assets | Still subject to forbidden headers |
| Can rewrite manifests client-side | Cross-origin CDN fetch still needs CORS |
| Good for same-origin CDN / signed cookies you control | **Cannot** inject third-party `Referer` to Luna |
| Offline/cache UX | Scope, HTTPS, update lifecycle complexity |

**Verdict:** Useless for Referer injection against a foreign CDN. Useful only if you already solved auth (signed URLs/cookies on *your* CDN) and want client-side caching/ABR tuning.

#### B. Edge Worker (Cloudflare / similar)

**Example:** [MHSanaei/HLS-Proxy-Worker](https://github.com/MHSanaei/HLS-Proxy-Worker)

- Worker fetches m3u8 (and often segments) with custom `Origin` / `Referer` / `User-Agent`.
- Rewrites relative URLs; returns CORS-friendly responses to the browser.
- Free tier: ~100k requests/day (easy to blow through with segment traffic).

| Pro | Con |
|-----|-----|
| Headers fully controllable | Full-proxy mode = all bytes through CF (cost/limits) |
| Globally closer to some CDNs than a home uplink | Cold starts, subrequest limits |
| Browser path is single hop to edge | ToS / abuse risk with third-party streams |
| Can hybrid: rewrite manifest only, 302 segments | 302 to Luna fails if segments need Referer |

**Verdict:** Strong for low-latency *if* the worker is allowed to proxy segments and you stay within limits. For household self-host with Tailscale, a home nginx/Go proxy is often simpler and has no CF daily caps.

---

### 3. Hybrid: “proxy only m3u8, segments direct”

**Pattern:**

1. Proxy fetches master + media playlists with injected headers.
2. Rewrites segment URIs to either:
   - **Absolute CDN URLs** (browser hits CDN), or
   - **302 redirects** from proxy → CDN ([Eyevinn `@eyevinn/hls-proxy`](https://github.com/Eyevinn/hls-proxy) `segmentRedirectHandler` / `mediaManifestHandler`).

| Variant | Bandwidth on home server | Requires segment auth? |
|---------|--------------------------|------------------------|
| Rewrite segments → absolute CDN URLs | Near-zero (only m3u8) | CDN must accept browser GETs without Referer + CORS |
| Proxy 302 → CDN | Near-zero bytes (headers only) | Same; browser still issues the segment GET |
| Proxy all segments | Full double-hop | Works with Referer inject |

**When hybrid works:** Public segments, token-in-URL segments, or CORS+cookie CDNs that don’t check Referer per segment.

**When hybrid fails (your case likely):** Luna requires `Referer` (and maybe cookies) on **every** segment GET → browser/CDN direct returns 403 → hybrid is not viable unless you discover segments are open after playlist auth (rare; verify with curl).

**Test once:**

```bash
# Playlist with Referer (should work)
curl -sI -H 'Referer: https://expected.site/' 'https://luna.../playlist.m3u8'

# Segment WITHOUT Referer (if 403 → hybrid dead)
curl -sI 'https://luna.../seg000.ts'

# Segment WITH Referer
curl -sI -H 'Referer: https://expected.site/' 'https://luna.../seg000.ts'
```

If segment without Referer fails → full proxy (or edge worker) required.

---

### 4. Open-source HLS restream proxies (speed-oriented)

| Project | Lang | Headers | m3u8 rewrite | Prefetch / cache | Notes |
|---------|------|---------|--------------|------------------|-------|
| **[warren-bank/node-HLS-Proxy](https://github.com/warren-bank/node-HLS-Proxy)** | Node | Referer, Origin, UA, cookies, hooks | Yes | **Yes** (`--prefetch`, max-segments, FS or memory) | Best OSS fit for buffering; Chromecast-friendly; GPL-2.0 |
| **[@eyevinn/hls-proxy](https://github.com/Eyevinn/hls-proxy)** | Node/Fastify | Via handlers | Yes (parsed m3u8) | No (302 redirect support) | Clean hybrid/multi-CDN; not a segment accelerator |
| **[MHSanaei/HLS-Proxy-Worker](https://github.com/MHSanaei/HLS-Proxy-Worker)** | CF Worker | Per-host rules | Playlist focus | CF edge cache possible | Zero home bandwidth option |
| **[pcruz1905/hls-restream-proxy](https://github.com/pcruz1905/hls-restream-proxy)** | — | Headers + token refresh | Yes | Restream toolkit | Aimed at Jellyfin/Emby/Plex ingest |
| **go-hls-proxy** (e.g. streamingriver) | Go | Varies | Basic | Often none | Low RAM, fast single binary |
| **Streamlink** `--player-external-http` | Python | Plugin headers | Transcode path | Different model | Better as pipe/player than pure HLS passthrough for hls.js |

**Speed levers that matter more than language:**

1. **Segment prefetch** (pull N segments ahead when m3u8 is seen) — directly fights 3.4s TTFB.
2. **Disk/memory cache** — multi-viewer / scrub / ABR switch reuse.
3. **Streaming body proxy** (don’t buffer full segment in Node heap before first byte).
4. **HTTP/1.1 keepalive / HTTP/2** to CDN + concurrent fetches.
5. **Avoid Next.js App Router for binary proxy** — use nginx, Go, or a thin Node HTTP server; Next adds middleware/runtime overhead.

---

### 5. nginx / Caddy as segment edge cache on the home server

**Goal:** Browser ↔ home is fast (LAN/Tailscale); home absorbs Luna latency once; cache serves subsequent hits.

#### nginx (recommended for this role)

```nginx
proxy_cache_path /var/cache/nginx/hls
  levels=1:2
  keys_zone=hls_cache:64m
  max_size=20g
  inactive=2h
  use_temp_path=off;

upstream luna {
  server cdn.example:443;
  keepalive 32;
}

server {
  listen 8080;
  # ... TLS / Tailscale host as needed

  # Short TTL for live playlists; longer for VOD playlists
  location ~ \.m3u8$ {
    proxy_pass https://cdn.example;
    proxy_ssl_server_name on;
    proxy_set_header Host cdn.example;
    proxy_set_header Referer https://expected.site/;
    proxy_set_header Origin https://expected.site;
    proxy_set_header User-Agent "Mozilla/5.0 ...";

    proxy_cache hls_cache;
    proxy_cache_key $uri$is_args$args;
    proxy_cache_valid 200 2s;          # live: 1–3s; VOD: 30s–5m
    proxy_ignore_headers Cache-Control Set-Cookie;
    add_header X-Cache-Status $upstream_cache_status;
    add_header Access-Control-Allow-Origin *;
  }

  location ~ \.(ts|m4s|mp4|aac|vtt)$ {
    proxy_pass https://cdn.example;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host cdn.example;
    proxy_set_header Referer https://expected.site/;
    proxy_set_header Origin https://expected.site;

    proxy_cache hls_cache;
    proxy_cache_key $uri$is_args$args;
    proxy_cache_valid 200 206 1h;     # VOD segments immutable → hours/days
    proxy_cache_lock on;              # stampede protection
    proxy_cache_use_stale error timeout updating;
    proxy_cache_background_update on;
    proxy_buffering on;
    proxy_ignore_headers Cache-Control Set-Cookie;
    add_header X-Cache-Status $upstream_cache_status always;
    add_header Access-Control-Allow-Origin *;
  }
}
```

**m3u8 rewrite:** nginx alone does not rewrite playlist bodies. Options:

- `sub_filter` / OpenResty / njs for simple URL rewrites, or
- Keep Next.js (or a tiny Node/Go service) **only** for m3u8 rewrite; put nginx **in front** as cache + segment proxy with header inject.

#### Caddy

- Excellent reverse proxy + automatic TLS.
- Response caching is **plugin-based** (`cache` / souin / caddy-cache) — more friction than nginx’s built-in `proxy_cache`.
- Historical community threads show HLS caching with third-party cache modules; fine for experiments, nginx is the production default for “edge cache at home.”

**Household effect:** First viewer pays ~3.4s/segment once; second TV / scrub / same title hit is LAN speed. Prefetch + cache together eliminate most rebuffering.

---

### 6. Signed URL / cookie injection → CORS-free direct segments?

| Technique | Who controls it? | Helps your Luna case? |
|-----------|------------------|------------------------|
| CloudFront / Akamai signed URLs | You (if you own distribution) | No — Luna signs, not you |
| Signed cookies (multi-segment) | You (CF `CloudFront-Policy` etc.) | Only on *your* CDN; still need CORS for hls.js |
| Cookie jar on **server** proxy | You | Yes — proxy holds session cookies for Luna |
| Token-in-query on segment URLs | Upstream | Hybrid possible **if** tokens appear in rewritten m3u8 |

**Signed cookies + CORS (CloudFront pattern):**

1. Your API sets cookies scoped to CDN domain.
2. Browser sends cookies on segment GETs automatically.
3. CDN must still send `Access-Control-Allow-Origin` (+ `Allow-Credentials` if not `*`) for hls.js to read bodies.
4. Cookies ≠ Referer. They solve **auth** when the CDN uses cookie auth; they do **not** replace Referer checks unless the CDN accepts cookie-only auth.

**Cookie injection without CORS?** Native Safari HLS sometimes plays cross-origin without CORS, but hls.js/MSE does not. For a web app on your domain playing Luna segments, CORS remains mandatory for MSE.

**Conclusion:** Unless Luna issues time-limited absolute segment URLs that work without Referer, signed-URL hybrid is unavailable. Server-side cookie jar + Referer inject remains the auth model.

---

## Architecture options (ranked for household self-host smoothness)

Ranking criterion: **playback smoothness** for 1–N household clients over LAN/Tailscale, given required Referer inject and slow Luna segments (~3.4s). Difficulty is self-host engineering cost.

---

### Rank 1 — nginx segment cache + thin m3u8 rewriter (Recommended)

```
Browser ──LAN/TS──► nginx (cache + header inject + CORS)
                       │
                       ├─ .m3u8 → Next.js/Go rewriter → Luna (short cache)
                       └─ .ts/.m4s → Luna (long cache, keepalive)
```

| | |
|--|--|
| **Smoothness** | Best for multi-device home; cache + optional prefetch layer |
| **Home bandwidth** | High on first play; low after warm cache / multi-viewer |
| **Latency** | First segment still ~3.4s unless prefetched; subsequent LAN |
| **Difficulty** | Medium (nginx + keep existing rewrite logic for playlists) |
| **Fits Referer** | Yes — nginx `proxy_set_header` |

**Implementation outline:**

1. Move segment proxying out of Next.js into nginx (or Caddy+plugin).
2. Keep Next.js only for m3u8 fetch/rewrite (or port rewrite to njs/OpenResty).
3. Point rewritten segment URLs at `https://home/hls/...` so they hit the cache.
4. Enable `proxy_cache_lock`, large `max_size`, separate TTLs for live vs VOD.
5. Optional: small side process that prefetches next N segments into nginx cache (or use Rank 2’s prefetch).

**Tradeoffs:** Disk space; cache key must include query tokens if URLs are signed; live playlists need low TTL to avoid stale windows.

---

### Rank 2 — Dedicated HLS proxy with prefetch (warren-bank or Go equivalent)

```
Browser ──► node-HLS-Proxy / go-hls-proxy
              ├── inject Referer/Origin/UA
              ├── rewrite m3u8 through proxy
              └── --prefetch N segments into RAM/disk
```

| | |
|--|--|
| **Smoothness** | Excellent for single active stream; prefetch hides 3.4s TTFB |
| **Home bandwidth** | Full stream × viewers (unless shared cache) |
| **Latency** | First playlist + first prefetch window; then near-stall-free |
| **Difficulty** | Low–medium (drop-in binary/npm; wire URL encoding) |
| **Fits Referer** | First-class |

**Why it ranks high:** Prefetch is the highest-ROI fix for “segment takes 3.4s.” Player buffer stays ahead of real-time.

**Tradeoffs:** GPL-2.0 for warren-bank; memory if many concurrent streams; still double-hop for uncached bytes; Next.js app must hand off player URL to proxy base URL.

**Hybrid with Rank 1:** Run prefetch proxy behind nginx, or prefetch into filesystem that nginx serves — best of both.

---

### Rank 3 — Cloudflare Worker (or similar) full proxy / hybrid

```
Browser ──► CF Worker (headers + rewrite [+ segment proxy])
              └── Luna CDN
```

| | |
|--|--|
| **Smoothness** | Often better WAN path than residential uplink to Luna |
| **Home bandwidth** | Near zero (good for weak home uplink) |
| **Latency** | Depends on Worker region vs Luna PoP |
| **Difficulty** | Low to deploy; medium to harden (auth, limits, logging) |
| **Fits Referer** | Yes |

**Tradeoffs:** Request/day and subrequest limits; egress cost at scale; ToS; less “self-host” control; free tier dies under continuous 1080p multi-user. Manifest-only Worker + direct segments only works if segments don’t need Referer (see §3).

**Best when:** Home uplink is the bottleneck (slow upload for Tailscale reverse path) more than Luna TTFB.

---

### Rank 4 — Hybrid m3u8-only proxy (Next.js keeps rewrite; segments absolute/302)

```
Browser ──► Next.js (m3u8 + headers only)
Browser ──► Luna segments direct (or 302)
```

| | |
|--|--|
| **Smoothness** | Best theoretical (one hop) **if allowed** |
| **Home bandwidth** | Minimal |
| **Latency** | Luna RTT only |
| **Difficulty** | Low (manifest rewrite change) |
| **Fits Referer** | **Only if segments don’t need it** |

**Action:** Run the curl tests in §3. If segments are open or tokenized in-URL without Referer, **jump this to Rank 1**. If 403, discard.

**Tradeoffs:** CORS must allow your web origin; tokens expire mid-session; no home-side buffering help if Luna is slow.

---

### Rank 5 — Status quo: Next.js full-proxy every byte

```
Browser ──► Next.js (headers + rewrite + pipe segments) ──► Luna
```

| | |
|--|--|
| **Smoothness** | Worst under load (Node/Next overhead + no cache/prefetch) |
| **Home bandwidth** | 2× path (CDN→home→client) |
| **Difficulty** | Already built |
| **Fits Referer** | Yes |

**Mitigations without re-architecture:**

- Stream responses (`duplex` / pipe), never `arrayBuffer()` whole segments.
- Concurrent segment-friendly HTTP agent (keepalive).
- Raise hls.js buffer: `maxBufferLength`, `maxMaxBufferLength`; tune `fragLoadPolicy` timeouts for 3.4s TTFB.
- Offload to Rank 1/2 ASAP for real fix.

---

## Decision matrix (quick)

| Constraint | Prefer |
|------------|--------|
| Referer required on segments (confirmed) | Rank 1 or 2 |
| Multiple TVs same show | Rank 1 (shared cache) |
| Single stream, max anti-stall | Rank 2 prefetch |
| Weak home upload / remote Tailscale clients | Rank 3 |
| Segments work without Referer | Rank 4 |
| Own CloudFront/S3 origin | Signed cookies + direct CDN (not Luna) |

---

## Recommended path for this household setup

1. **Verify** segment Referer requirement (curl §3).  
2. If required → **deploy nginx cache + header inject** in front of (or replacing) Next segment proxy.  
3. **Add prefetch** (warren-bank `--prefetch` or custom N-ahead fetcher writing into cache) to absorb 3.4s Luna TTFB.  
4. Keep Next.js only for app UI + m3u8 rewrite if rewrite is complex.  
5. Tune hls.js: larger buffer, longer `maxTimeToFirstByteMs` / `maxLoadTimeMs` for slow first byte.  
6. Consider CF Worker only if remote clients suffer from home upload caps more than from double-hop.

**Do not invest in:** browser `xhrSetup` Referer spoofing, service-worker Referer injection, or hybrid-direct segments without a successful no-Referer segment test.

---

## Appendix A — hls.js knobs (still useful under any architecture)

```js
new Hls({
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  startFragPrefetch: true,
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15000, // tolerate ~3.4s+ Luna
      maxLoadTimeMs: 120000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
    },
  },
  // xhrSetup / fetchSetup: only for headers you are allowed to set,
  // and only against origins that allow them via CORS — not Luna Referer.
});
```

## Appendix B — Key references

- hls.js API: `xhrSetup`, `fetchSetup`, CORS requirement — [video-dev/hls.js docs](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
- Fetch forbidden request headers (includes `Referer`) — [fetch.spec.whatwg.org](https://fetch.spec.whatwg.org/#forbidden-request-header)
- Eyevinn HLS proxy / hybrid rewrite + 302 — [dev.to + @eyevinn/hls-proxy](https://dev.to/video/open-source-hls-proxy-library-for-manifest-manipulation-1e9n)
- warren-bank node-HLS-Proxy (headers, prefetch, cache) — [GitHub](https://github.com/warren-bank/node-HLS-Proxy)
- CF Worker HLS proxy pattern — [MHSanaei/HLS-Proxy-Worker](https://github.com/MHSanaei/HLS-Proxy-Worker)
- nginx HLS edge cache patterns — SRS docs / common `proxy_cache` for `.m3u8` vs `.ts`
- Service workers as media proxies — [Mux blog](https://www.mux.com/blog/service-workers-are-underrated) (manifest rewrite; not third-party Referer)
- CloudFront signed cookies for multi-file HLS — AWS / independent writeups (only if **you** control the CDN)

---

## Appendix C — Option scorecard (1–5, higher better for household)

| Option | Smoothness | Self-host fit | Difficulty (invert: 5=easy) | Referer OK | Total |
|--------|------------|---------------|-----------------------------|------------|-------|
| 1 nginx cache + thin rewrite | 5 | 5 | 3 | 5 | **18** |
| 2 Prefetch HLS proxy | 5 | 4 | 4 | 5 | **18** |
| 3 CF Worker | 4 | 2 | 4 | 5 | **15** |
| 4 Hybrid direct segments | 5* | 5 | 5 | 1* | **16*** |
| 5 Next.js full proxy | 2 | 4 | 5 | 5 | **16** |

\*Rank 4 total collapses if segment Referer is required (smoothness→0).  

**Tie-break Rank 1 vs 2:** Prefer **1** for multi-client households; prefer **2** for fastest single-stream fix; **combine both** when possible.
