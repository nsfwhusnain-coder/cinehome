# Research: Edge Workers vs Home Proxy for Smooth Client-Side Playback

**Date:** 2026-07-09  
**Scope:** How movie-web / sudo-flix / similar FOSS players get smooth HLS without a heavy home proxy; whether a Cloudflare Worker (or similar) can fix double-hop latency for a Tailscale household running CineHome.

**CineHome context:** Today, CineHome terminates HLS at the app origin (`/api/hls/[sessionId]`): rewrites manifests, injects Referer/Origin/UA/cookies, prefetches/caches segments in-process. Remote clients over Tailscale therefore do:

`Client → Tailscale → home Node → provider CDN → home → Tailscale → client`

That is the double-hop problem this note evaluates.

---

## 1. movie-web / sudo-flix / similar FOSS architecture

### Stack (public GitHub)

| Piece | Repo / role | What it does |
| --- | --- | --- |
| Frontend SPA | `sussy-code/smov` (sudo-flix; movie-web lineage) | React UI; scrapes sources in-browser via providers package; plays with HLS.js / native |
| Providers | `sussy-code/providers` (`@movie-web/providers`) | Client **and** server scrapers; returns stream URLs + required headers (Referer, Origin, etc.) |
| simple-proxy | `sussy-code/sudo-proxy` (fork of movie-web simple-proxy) | Lightweight reverse proxy (Nitro); **designed for Cloudflare Workers** (also Node, Lambda, Netlify Edge) |
| Extension | `sussy-code/browser-ext` | MV3 + `declarativeNetRequest`; scrapes more sources; **removes need to proxy media** |
| Backend | `sussy-code/backend` | Accounts / progress sync only — **not** a media plane |

### Architectural principle

**Separate scrape plane from media plane.**

1. **Scrape plane (small):** Discover embed/API endpoints, resolve m3u8/DASH URLs, collect cookies/headers. Often goes through simple-proxy **or** extension `makeRequest` (background `fetch` with forged headers).
2. **Media plane (huge):** Manifest + every `.ts` / `.m4s` segment.

movie-web’s smoothness comes from **not hauling media through a home box**. Preferred path:

```
Browser  ──(scrape via extension or tiny CF proxy)──►  provider APIs
Browser  ──(HLS segments DIRECT to CDN)────────────►  CDN edge near user
```

Fallback (no extension):

```
Browser  ──►  simple-proxy (CF Worker)  ──►  provider / CDN
```

Media still may traverse the Worker, but the Worker is **global edge**, not a single household uplink.

### What the proxy actually is

`sudo-proxy` is not a “video platform.” It is a thin CORS/header proxy:

- Query: `?destination=<url>`
- Maps client-safe headers → real ones:
  - `X-Referer` → `Referer`
  - `X-Origin` → `Origin`
  - `X-Cookie` → `Cookie`
  - `X-User-Agent` → `User-Agent`
- Response always adds `Access-Control-Allow-Origin: *` (+ expose headers)
- Optional Cloudflare Turnstile to stop open-proxy abuse
- Does **not** re-encode; streams the upstream body through

Source: [sussy-code/sudo-proxy](https://github.com/sussy-code/sudo-proxy) `src/routes/index.ts`, `src/utils/headers.ts`.

---

## 2. Proxy vs provider CORS

### Why a proxy exists at all

Browser rules for HLS.js / MSE:

| Resource | CORS needed? | Why |
| --- | --- | --- |
| Plain `<video src="…mp4">` progressive | Often no | Media element can play cross-origin without reading bytes |
| HLS via **hls.js / MSE** | **Yes** | JS must read manifests/segments into `SourceBuffer` |
| Provider CDNs | Usually **no** useful CORS for random sites | Hosts expect traffic from their own embed origin |

So pure client SPA on `cinehome.example` cannot `fetch()` `https://storm.vodvidl.site/.../seg.ts` unless:

1. CDN already sends `Access-Control-Allow-Origin` that matches the SPA, **or**
2. Something injects CORS (proxy or extension), **or**
3. Native HLS (Safari) can sometimes play without JS reading bytes — fragile and not enough for header-gated CDNs.

### Header gate (Referer / Origin)

Many CDNs used by embeds (VidLink-class, VidKing-class, etc.) do not rely on CORS alone. They check:

- `Referer: https://vidlink.pro/`
- `Origin: https://vidlink.pro`
- sometimes cookies / signed query tokens

CineHome already encodes this (`REFERER_OVERRIDES` in `hls-proxy.ts` for `storm.vodvidl.site`, `*.hakunaymatata.com`, `moon.ironbubble.site`, etc.). movie-web does the same via proxy header map or extension request headers.

### Provider “CORS-friendly” streams

Some resolved sources already allow `*` or are same-site as an iframe player. Those can be pointed at directly. Most quality sources do **not** — hence proxy/extension.

**Bottom line:** movie-web does **not** depend on providers enabling CORS for random frontends. It **forces** browser-acceptable responses via:

- edge proxy (adds ACAO + forges Referer), or  
- extension (same, client-side).

---

## 3. Extension-based approach (header injection, zero media hop)

### How sudo-flix / movie-web extension works

Public sources:

- [sussy-code/browser-ext](https://github.com/sussy-code/browser-ext)
- Permissions: `declarativeNetRequest`, `storage`, `cookies`, optional `<all_urls>`
- Messages: `makeRequest`, `prepareStream`, `hello`, `openPage`

#### A. `makeRequest` — scrape without CORS

1. Extension installs a **dynamic DNR rule** for the target hostname.
2. Sets request headers (Referer, Origin, UA, …).
3. Forces response headers:
   - `Access-Control-Allow-Origin: *` (or credentials path)
   - methods / allow-headers
4. Background page `fetch()`es the URL (extension origin is not bound by page CORS the same way after DNR rewrites).
5. Removes the rule; returns body + headers to the page.

#### B. `prepareStream` — play media **directly from CDN**

1. Page asks extension to register DNR rules for stream host(s) / regex.
2. Rules set:
   - **Request:** Referer / Origin / whatever provider needs  
   - **Response:** `Access-Control-Allow-Origin: *`, allow methods/headers
3. HLS.js then hits CDN URLs **from the page** with no intermediate server.
4. Bytes never touch home or CF.

Reddit-era explanation (movie-web users): *“so that you can connect directly to the stream so they don’t have to proxy it.”*

### Pros / cons vs home proxy

| | Extension | Home proxy (CineHome today) | CF Worker proxy |
| --- | --- | --- | --- |
| Media path | Client → CDN | Client → home → CDN | Client → CF edge → CDN |
| Latency | Best (one hop) | Worst remote (double hop + home uplink) | Good (edge near client) |
| Setup | Install + whitelist domain | Zero client install | Zero client install |
| TV / mobile / PWA | Weak / none | Works everywhere | Works everywhere |
| Trust model | User must install privileged ext | You control server | You control Worker |
| Bandwidth cost | CDN pays / free for host | Home egress + upload | CF free-tier / ToS risk |

**For household multi-device (TV apps, phones without side-loaded ext): extension is not a full substitute.** It is the gold path for desktop browsers only.

---

## 4. Cloudflare Workers as household edge proxy

### Pattern already in the wild

1. **movie-web simple-proxy** — general CORS + header rewrite (Nitro → Workers).
2. **HLS-Proxy-Worker** ([MHSanaei/HLS-Proxy-Worker](https://github.com/MHSanaei/HLS-Proxy-Worker)) — playlist fetch, relative→absolute rewrite, per-domain Origin/Referer rules; marketed for free CF accounts (100k req/day).
3. Community “cors-anywhere on Workers” forks.

### What a Worker can do for CineHome

| Job | Feasible on Worker? | Notes |
| --- | --- | --- |
| Inject Referer/Origin/UA/Cookie | Yes | Core of simple-proxy |
| Add CORS for SPA | Yes | `ACAO: *` or reflect Origin + credentials care |
| Rewrite m3u8/DASH URLs to stay on Worker | Yes | Same idea as CineHome `proxyUrlFor` |
| Stream segment bodies | Yes (streaming `fetch` + pass-through) | Do **not** buffer whole bodies (128 MB isolate) |
| Edge cache segments (Cache API) | Partially | Per-colo cache; 512 MB object cap; **not** full tiered CDN for video; ToS risk |
| Prefetch next N segments | Possible but burns free quota | Each prefetch = request + subrequest |
| Session auth (userId) | Yes | Shared secret / JWT in query; keep session map in Worker KV/DO if multi-colo |
| Transcoding | No | Out of scope |

### Free-tier hard numbers (Workers Free)

| Limit | Value | HLS impact |
| --- | --- | --- |
| Requests / day | **100,000** | Binding constraint |
| CPU / request | 10 ms | Fine if only header rewrite + stream |
| Subrequests / invocation | 50 | One fetch upstream = 1; rewrite-only is fine |
| Memory / isolate | 128 MB | Stream; never `arrayBuffer()` whole movies |
| Response body | No hard cap | Streaming OK |
| Cache API object | 512 MB | Segments usually 0.5–4 MB |

#### Request math (rough)

Assume VOD HLS:

- 1 master + 1 media playlist  
- ~6 s segments → **10 segment GETs / minute**  
- 2h movie ≈ **1,200 segment requests** + playlists + quality switches ≈ **~1,300–1,800 req / movie**

| Concurrent household use | Req / day (order of magnitude) | Free tier? |
| --- | --- | --- |
| 1 full movie | ~1.5k | Easy |
| 4 movies / night | ~6k | Easy |
| 2 simultaneous streams × 4h | ~10k–15k | Fine |
| Always-on multi-user public | 100k+ | Breaks free tier |

**Household Tailscale use stays under free request limits easily.** Bandwidth is not metered on Free Workers the same way, but **ToS is the real constraint** (next section).

### Cloudflare ToS / video CDN policy (important)

Cloudflare’s self-serve terms historically reserve the right to limit use of the CDN for **disproportionate video / large-file delivery** unless you use Stream / Enterprise / appropriate paid products. Community reports: accounts limited for proxying HLS/TS through orange-cloud or Workers at scale.

For a **private household Worker** (auth-gated, low concurrent streams):

- Practically many people run simple-proxy with no issue.
- Legally / policy-wise: **not a free unlimited video CDN**. Risk rises if open to the internet, unauthenticated, or multi-Mbps sustained egress for many users.
- Safer design for household:
  - Auth (Tailscale-only DNS, or CF Access, or signed short-lived tokens from CineHome)
  - Proxy **only** when headers/CORS required
  - Prefer **direct CDN** when stream already works without headers
  - Cache only short TTL for hot segments if at all; don’t market as public CDN

Paid Workers ($5) removes 100k/day and raises CPU; **does not** erase video ToS concerns for bulk media.

---

## 5. Can a Worker fix double-hop latency for a Tailscale household?

### Latency models

Notation:

- \(L_{c\to h}\) — client ↔ home (Tailscale / WAN)
- \(L_{h\to cdn}\) — home ↔ provider CDN
- \(L_{c\to e}\) — client ↔ nearest CF colo  
- \(L_{e\to cdn}\) — CF colo ↔ provider CDN  
- \(L_{c\to cdn}\) — client ↔ provider CDN direct  

Typical orders of magnitude (illustrative; measure with `curl -w`):

| Path hop | Same city | Cross-country | Continent-cross |
| --- | --- | --- | --- |
| Client ↔ home (Tailscale) | 5–30 ms | 40–100 ms | 100–200+ ms |
| Client ↔ CF edge | 5–20 ms | 15–40 ms | 30–80 ms |
| Edge/home ↔ big CDN | 5–40 ms | 20–80 ms | 40–120 ms |

#### Path A — CineHome home proxy (today, remote)

Every segment:

\[
T_A \approx 2\,L_{c\to h} + 2\,L_{h\to cdn}
\]

(request up + body down; simplified RTT sum)

Example remote client 80 ms RTT to home, home 40 ms RTT to CDN:

\[
T_A \approx 2(80) + 2(40) = 240\ \text{ms RTT-equivalent per segment start}
\]

Plus home **upload** of video to client (asymmetric residential uplink often 10–50 Mbps caps multi-stream).

#### Path B — CF Worker as media proxy (no home in media path)

\[
T_B \approx 2\,L_{c\to e} + 2\,L_{e\to cdn}
\]

Example client 20 ms to CF, CF 30 ms to CDN:

\[
T_B \approx 2(20) + 2(30) = 100\ \text{ms}
\]

**Often 2× faster time-to-first-byte than Path A** for remote users. Also **removes residential uplink** as the bottleneck: CF egress, not home cable upload.

#### Path C — Extension / direct CDN (movie-web ideal)

\[
T_C \approx 2\,L_{c\to cdn}
\]

Best possible (~40–80 ms in good regions). No middlebox CPU.

#### Path D — Hybrid (recommended for CineHome)

```
Scrape / session mint:  Client → CineHome (home or hosted) → providers
Media:                  Client → Worker?u=…&sig=… → CDN
Optional fallback:      Client → CineHome /api/hls/… → CDN  (LAN / if Worker down)
```

LAN clients at home: home proxy can be **faster** than CF if CDN is far and home is on good fiber (`L_{c\to h}≈1 ms`). Detect LAN vs remote.

### Rough end-to-end startup (buffer 3 × 2s segments)

| Path | TTFB-ish per segment | 3 segments serial worst-case | Notes |
| --- | --- | --- | --- |
| A Home remote | ~240 ms | ~720 ms + transfer | Transfer dominated by home upload |
| B CF Worker | ~100 ms | ~300 ms + transfer | Transfer from CF edge; usually better |
| C Direct/ext | ~60 ms | ~180 ms + transfer | Best |
| A Home LAN | ~50 ms | ~150 ms | Competitive with B |

HLS players pipeline segment fetches; absolute numbers improve with parallel requests, but **uplink saturation** on Path A still kills multi-device remote watching.

### Does Worker give “global edge cache”?

**Partially, not magically.**

- **Cache API / `fetch` cache:** caches at the **colo that handled the request**, not a single global store. Second household member in same metro may hit; someone on another continent often re-pulls origin.
- **Cold miss:** still `edge → CDN` every time; benefit is geo proximity + no home hop.
- **Hot same-colo multi-viewer:** Worker cache can cut CDN origin hits for popular titles inside one colo — household-scale win is modest (few users).
- **CineHome in-memory segment cache** only helps **processes on that machine**; useless for remote unless bytes still exit home.

Worker in front of CDN = **edge proxy + optional soft cache**, not Netflix-grade multi-tier CDN unless you put content on R2/Stream (wrong product for third-party licensed segments).

---

## 6. CineHome-specific recommendation

### What movie-web teaches CineHome

1. **Don’t put heavy media on the household origin if clients are remote.**  
   CineHome’s current design is correct for **header injection + rewrite** but wrong **placement** for remote Tailscale users.
2. **Proxy is a thin function**, not a media server: forge headers, rewrite playlist URLs, stream through, add CORS.
3. **Extension is optional optimization**, not the multi-device household path.
4. **simple-proxy on Workers is the industry-standard FOSS pattern** for this exact problem.

### Proposed architecture

```
┌─────────────┐     scrape / API / UI      ┌──────────────────┐
│  Browser /  │ ─────────────────────────► │ CineHome origin  │
│  TV client  │ ◄──── session token ────── │ (home or VPS)    │
└──────┬──────┘                            └────────┬─────────┘
       │                                            │
       │  m3u8 + segments (signed Worker URLs)      │ mint rules
       ▼                                            ▼
┌──────────────────┐                       provider scrapers
│ CF Worker        │
│ - verify sig     │
│ - inject headers │
│ - rewrite m3u8   │
│ - stream / cache │
└────────┬─────────┘
         ▼
   Provider CDN
```

**Session model:** Keep CineHome’s `HlsSession` (referer, origin, UA, cookies, extras) but store it where Worker can read it:

- Option 1: encrypt session blob into the Worker URL (HMAC, short TTL) — no shared state  
- Option 2: Worker KV / Durable Object keyed by session id (closer to current Map)

**Manifest rewrite:** Same as today — every segment URI becomes  
`https://hls.yourdomain.workers.dev/s/<id>?u=<b64url>&sig=…`  
instead of `/api/hls/...` on home.

### When NOT to use Worker for media

- Client is on LAN next to CineHome (use home proxy or direct).
- Stream already plays with native CORS + no Referer lock (direct URL).
- You need heavy buffering/prefetch logic tightly coupled to Node (can reimplement on Worker).
- You plan public unauthenticated proxy (ToS + abuse + free tier death).

### Alternatives to CF Worker

| Option | Fit |
| --- | --- |
| **Fly.io / Railway mini proxy** near users | Similar to Worker; pay for egress; clearer “you host a proxy” |
| **Deno Deploy / Netlify Edge** | simple-proxy already targets these |
| **VPS in same region as users** | Predictable; no CF video ToS |
| **Browser extension for desktop only** | Best latency; optional upgrade |
| **Tailscale + exit node near CDN** | Doesn’t inject headers; doesn’t solve CORS |
| **Cloudflare Tunnel only** | Still double-hops media through home |

---

## 7. Pros / cons summary: Worker vs home proxy for Tailscale household

### Worker in front of CDN

**Pros**

- Removes double hop and home **upload** bottleneck for remote clients  
- Latency often ~½ of home-proxy path for cross-region users  
- Same pattern as movie-web simple-proxy (known working design)  
- Free tier request quota enough for a family  
- Header injection + CORS + m3u8 rewrite are a few dozen lines  
- Scales multi-device without saturating residential uplink  
- Can sit on custom domain + CF Access for household-only

**Cons**

- CF ToS risk if treated as bulk video CDN / open proxy  
- Free 100k req/day fails if public or very chatty  
- Per-colo cache ≠ true global multi-tier CDN  
- Session state must leave single Node process (sign or KV)  
- Debugging harder than local Node logs  
- Cold Worker + cold CDN still two network legs (just better placed)  
- Some providers block known CF IP ranges (occasional)

### Keep heavy home proxy only

**Pros**

- Full control, no CF ToS  
- Existing CineHome code path  
- Great on LAN  
- Easy cookies/session in memory  

**Cons**

- Remote: **double hop + residential upload**  
- Multi-stream remote quality tanks  
- Home IP exposed to provider (ban risk concentrated)  
- Power/uptime of home box required for all watching  

### Hybrid (best balance)

| Client location | Media path |
| --- | --- |
| LAN / same Tailscale subnet as host | Home `/api/hls` or direct |
| Remote Tailscale / internet | Signed CF Worker |
| Desktop Chrome/Firefox + optional ext | Direct CDN after DNR prepareStream |

---

## 8. Latency math cheat-sheet (use for design reviews)

**Double-hop penalty (extra RTT vs direct):**

\[
\Delta \approx 2\,L_{c\to h} + 2\,L_{h\to cdn} - 2\,L_{c\to cdn}
\]

If client is near home and home is near CDN, \(\Delta\) is small.  
If client is abroad and home is in one city, \(\Delta\) is large (often **100–300 ms+** per segment cycle plus bandwidth pain).

**Worker win vs home (remote):**

\[
\Delta_{win} \approx T_A - T_B \approx 2(L_{c\to h}-L_{c\to e}) + 2(L_{h\to cdn}-L_{e\to cdn})
\]

Usually positive when \(L_{c\to h} \gg L_{c\to e}\).

**Bandwidth note:** A 5 Mbps stream remote through home needs **5 Mbps continuous upload** from home. Two concurrent 4K-ish streams can exceed many residential uplinks. Worker path uses **download-only at home** for scrape, not media.

---

## 9. Direct answers

| Question | Answer |
| --- | --- |
| How do movie-web etc. stay smooth without a home proxy? | Client-side scrape + **direct CDN play**; extension or tiny edge proxy only for CORS/headers — not a household media relay. |
| Proxy or provider CORS? | Almost always **proxy or extension**; providers rarely give open CORS + correct Referer. |
| Extension? | DNR modifies request/response headers so page talks to CDN **directly**. Best latency; poor for TV/PWA. |
| CF Worker free for household? | **Yes for request volume**; stream pass-through works; **auth-gate** and respect video ToS. |
| Worker fix Tailscale double-hop? | **Yes, for remote clients**, if media moves off home onto Worker (or direct/ext). Pure Tunnel still double-hops. |
| Global edge cache? | Soft per-colo cache only; main win is **path geometry + egress**, not Netflix-like multi-tier caching of third-party VOD. |

---

## 10. Suggested next experiments (implementation-ready, not done here)

1. Deploy movie-web `simple-proxy` (or 50-line Worker) with HMAC-signed destinations derived from CineHome session.  
2. Measure with one remote client:  
   - TTFB home `/api/hls` vs Worker vs direct URL (VLC/curl).  
   - Sustained Mbps home uplink during 1080p play.  
3. Feature-flag in CineHome: `PLAYBACK_PROXY=home|worker|auto` (`auto` = LAN→home, else→worker).  
4. Keep manifest rewrite + header maps from `hls-proxy.ts`; move `fetchProxied` body path to Worker first; leave scrape on CineHome.

---

## Sources (public)

- https://github.com/sussy-code/smov — sudo-flix frontend; links extension + proxy + backend  
- https://github.com/sussy-code/sudo-proxy — simple-proxy (CORS, header rewrites, CF Workers)  
- https://github.com/sussy-code/browser-ext — DNR `prepareStream` / `makeRequest`  
- https://github.com/sussy-code/providers — `@movie-web/providers`  
- https://github.com/MHSanaei/HLS-Proxy-Worker — HLS rewrite + Origin/Referer on Workers  
- https://developers.cloudflare.com/workers/platform/limits/ — free tier, CPU, cache  
- Cloudflare ToS / community: self-serve video/large-file CDN restrictions  
- CineHome: `/Users/husnainali/cinehome-app/src/lib/hls-proxy.ts`, `hls-session.ts`

---

*Researcher note: This is architecture research only. Deploying open proxies against third-party CDNs may violate those CDNs’ terms; keep any Worker private to the household and auth-gated.*
