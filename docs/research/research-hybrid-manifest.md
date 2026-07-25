# Hybrid Manifest Proxy vs Full Segment Proxy

**Topic:** hls.js “passthrough” of absolute CDN segment URLs after server-side m3u8 rewrite  
**For:** CineHome (`/api/hls/{session}`, `hls-proxy.ts`, scraper-captured Referer/Cookie)  
**Date:** 2026-07-09  

---

## 0. Terminology (avoid confusion)

| Term | What it actually means |
|------|------------------------|
| **Hybrid / manifest-only proxy** | Server fetches + rewrites `.m3u8` (and often keys); **segment URIs stay absolute CDN URLs**. Browser hits CDN for `.ts` / `.m4s` / `.jpg` segments. |
| **Full proxy** | Master, media playlists, keys, **and every segment** go through your origin (`/api/hls/...`). Current CineHome path. |
| **hls.js `PassThroughRemuxer`** | Internal remux path for fMP4 (no transmux). **Not** a network/CORS feature. |
| **`fetch` `mode: 'no-cors'`** | Produces an **opaque** response: JS cannot read body/headers/status. **Unusable for hls.js / MSE.** |

hls.js official requirement (docs):

> All HLS resources must be delivered with CORS headers permitting `GET` requests.

That applies to **every** resource hls.js loads via XHR/fetch: master m3u8, media m3u8, init maps, segments, AES keys, VTT, etc. The browser must hand a **readable** `ArrayBuffer` to MediaSource.

---

## 1. Can we rewrite m3u8 on the server but leave segments as absolute CDN URLs?

### Short answer: **Yes — when the CDN allows the browser origin to read segment bodies via CORS.**

### How hybrid works

```
Browser (origin: https://cinehome.example)
    │
    │ 1. GET /api/hls/{sid}?u=…master.m3u8     (same-origin → no CDN CORS needed)
    ▼
CineHome proxy
    │ 2. Server-side GET master + media m3u8
    │    (injects Referer/Origin/Cookie/UA from scraper session)
    │ 3. Rewrite:
    │    - relative → absolute CDN URLs for segments
    │    - nested playlists / keys: either proxy URLs OR absolute CDN
    │ 4. Return rewritten playlist with CORS from *your* origin
    ▼
Browser / hls.js
    │ 5. GET https://cdn.example/seg001.ts      (cross-origin)
    │    Requires CDN Access-Control-Allow-Origin usable by CineHome origin
    ▼
CDN
```

### What the rewritten media playlist looks like

**Upstream (relative):**
```m3u8
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
```

**Hybrid (manifest proxy, segment passthrough):**
```m3u8
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
https://cdn.example/path/seg0.ts
#EXTINF:6.0,
https://cdn.example/path/seg1.ts
#EXT-X-KEY:METHOD=AES-128,URI="/api/hls/{sid}?u=…key.bin"   # often still proxy keys
```

**Full proxy (current CineHome `rewriteM3u8`):**
```m3u8
#EXTINF:6.0,
/api/hls/{sid}?u={base64url(https://cdn.example/path/seg0.ts)}
```

Eyevinn’s `hls-proxy` documents the same split explicitly: rewrite media manifest so “the proxy does not have to handle each segment request,” vs `segmentRedirectHandler` 302s for every segment.

### Nested playlists

Hybrid is **not** “proxy only the first m3u8.” You must still handle:

| Resource | Hybrid-friendly? | Notes |
|----------|------------------|--------|
| Master → media variant URIs | Usually **proxy** | Live/ABR: media playlists refresh; keep them same-origin so you can re-absolute-ize segments each time. |
| Media → segment URIs | **Absolute CDN** | The win: bandwidth leaves your server. |
| `#EXT-X-MAP` init | Absolute CDN if CORS OK | Same rules as segments. |
| `#EXT-X-KEY` URI | **Usually proxy** | Keys often no CORS / need cookies / short TTL. |
| I-frame / audio / subtitle playlists | Proxy or absolute by same rules | Don’t leave relative URIs pointing at your domain incorrectly. |

**Critical rewrite rule:** If a media playlist is served from `https://cinehome.example/api/hls/...`, any **relative** segment URI resolves against the **proxy URL**, not the CDN. Hybrid **must** absolutize every non-proxied URI against the **upstream** playlist URL before returning the body.

---

## 2. When hybrid fails

### 2.1 CORS on segments (most common)

hls.js loads segments with credentialed-or-not XHR/fetch in **CORS mode** (not `no-cors`). Browser requires:

```
Access-Control-Allow-Origin: https://cinehome.example
  OR
Access-Control-Allow-Origin: *
```

Failures:

| CDN response | Browser effect | Hybrid viable? |
|--------------|----------------|----------------|
| No `ACAO` header | CORS error; body blocked | **No** |
| `ACAO: https://embed.provider.com` only | Your origin not allowed | **No** |
| `ACAO: *` | Readable without cookies | **Yes** (if no credentials needed) |
| `ACAO: *` + cookies required | Invalid combo; cookies not usable with `*` | **No** (unless signed URL auth only) |
| `ACAO: <your-origin>` + `ACAC: true` | Works if you send credentials | **Maybe** (cookie domain issues below) |

**Native `<video src=m3u8>` (Safari)** is more lenient for media element loads, but **hls.js + MSE always needs CORS-readable responses**. Hybrid that “works in Safari native” can still fail in Chrome with hls.js.

### 2.2 `no-cors` is a dead end

- Opaque responses: status `0`, body unreadable.
- Cannot `appendBuffer` to SourceBuffer.
- Cannot inspect status for retries.
- **Do not** try `mode: 'no-cors'` as a hybrid workaround.

### 2.3 Signed cookies / session cookies

Typical CDN pattern: set `CloudFront-Policy` / custom session cookies on **embed domain** or **CDN domain** when the embed page loads.

| Problem | Why hybrid breaks |
|---------|-------------------|
| Cookie set for `.vidking.net`, page is `cinehome.example` | Browser **never** attaches those cookies to CDN requests from your origin |
| Cookie requires `SameSite=None; Secure` and correct Domain | Embed cookies often not visible to third-party page |
| hls.js default is **no credentials** on cross-origin | Even if cookie domain matches CDN, you need `xhr.withCredentials = true` / `credentials: 'include'` **and** `ACAO` must be exact origin (not `*`) **and** `Access-Control-Allow-Credentials: true` |
| Server proxy can attach `Cookie:` header | Browser hybrid **cannot** set arbitrary Cookie headers on cross-origin CDN requests |

**CineHome implication:** Scraper captures `session.cookies` and proxy injects them server-side. That only works on **full proxy** (or hybrid where keys still go through proxy but segments need cookies → segments still fail).

### 2.4 Referer / Origin / hotlink protection

Many pirate/stream CDNs (including VidLink/Vidking-style hosts CineHome already special-cases) enforce:

- `Referer: https://vidlink.pro/` or `https://www.vidking.net/`
- Matching `Origin`
- Sometimes token query params bound to that session

Browser hybrid requests send:

```
Origin: https://cinehome.example
Referer: https://cinehome.example/watch/...
```

CDN returns **403** (or empty body). Server proxy can forge Referer/Origin; the browser **cannot** (forbidden header names / browser-controlled).

CineHome already has `REFERER_OVERRIDES` for:

- `storm.vodvidl.site`, `*.hakunaymatata.com` → `https://vidlink.pro/`
- `moon.ironbubble.site`, `infantinostreet.site`, `ironbubble.site` → `https://www.vidking.net/`

Those hosts almost certainly need **full proxy** for segments.

### 2.5 Signed query-string URLs (time-limited)

If segments are `seg.ts?token=…&expires=…` **already absolute and self-contained**:

- Hybrid **can** work **if** CORS is open and no Referer check.
- Token expiry still applies; live manifests must keep being proxied so refreshed segment URLs reach the player.

If only the **manifest** is signed and segments rely on cookies or IP stickiness after a signed playlist fetch: hybrid may work briefly from the server’s IP context when **you** fetch the playlist, but browser segment GETs use client IP → **403**.

### 2.6 AES-128 / SAMPLE-AES keys

- Key URI often relative; must be absolute or proxied.
- Key fetch is also XHR → needs CORS if left on CDN.
- Keys frequently gated harder than segments.

**Recommendation:** always proxy `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` URIs even in hybrid mode.

### 2.7 Byte-range segments (`#EXT-X-BYTERANGE`)

hls.js issues `Range: bytes=…` requests. May trigger CORS **preflight** (non-simple). Needs:

- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS` (and Range if preflighted)
- Often `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length`
- Correct `206` + `Content-Range` on CDN

Missing expose headers → subtle MSE failures.

### 2.8 CDN / cache CORS footguns

- CloudFront/S3: first request **without** `Origin` cached → subsequent browser requests missing `ACAO` (classic “CORS stripped by cache”). Needs `Vary: Origin` / Origin in cache key.
- Cloudflare or intermediate proxies stripping CORS headers.
- Preflight OPTIONS not handled → Range/custom header fails.

### 2.9 Mixed content / protocol

- Page HTTPS + segment HTTP → blocked.
- Always rewrite to `https://` when possible.

### 2.10 DRM / EME

License servers and key systems are separate; hybrid segment CORS still required for clear/clear-key segments. Widevine license URLs often need their own CORS/proxy.

---

## 3. How to detect if a CDN allows CORS (or “no-cors”) for segments

### 3.1 Reality check on “no-cors”

| Mode | Can hls.js use body? | Useful for detection? |
|------|----------------------|------------------------|
| `cors` | Yes if ACAO allows | **Yes** — this is what you need |
| `no-cors` | **No** (opaque) | Only proves “TCP/TLS + not network-blocked”; **not** playability |
| `same-origin` | N/A for CDN | N/A |

**Detection target:** “Readable CORS GET from our page origin,” not “no-cors succeeds.”

### 3.2 Server-side probe (recommended for CineHome session setup)

Run **after** you have a media playlist and one absolute segment URL (and optional key URL).

```bash
# Simulate browser CORS GET (simple GET usually no preflight)
ORIGIN="https://cinehome.example"   # production app origin
SEG="https://cdn.example/path/seg0.ts"

curl -sS -D - -o /dev/null \
  -H "Origin: ${ORIGIN}" \
  -H "Referer: ${ORIGIN}/" \
  -H "User-Agent: Mozilla/5.0 ..." \
  "${SEG}" | tr -d '\r' | grep -iE '^(HTTP/|access-control-|content-type:)'
```

**Pass criteria (hybrid segments OK):**

1. HTTP **200** or **206** (not 401/403).
2. `Access-Control-Allow-Origin: *` **or** exact match to `ORIGIN`.
3. If you will send cookies: `ACAO` exact origin + `Access-Control-Allow-Credentials: true` (never `*`).
4. Optional preflight when using Range:

```bash
curl -sS -D - -o /dev/null -X OPTIONS \
  -H "Origin: ${ORIGIN}" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: range" \
  "${SEG}"
```

### 3.3 Auth-aware probe matrix

| Probe | Headers | Interpreting failure |
|-------|---------|----------------------|
| A. Bare GET | none | 200 + no ACAO → **open bytes, closed CORS** → full proxy |
| B. Browser-like | `Origin` + page `Referer` | 403 → hotlink / origin lock → full proxy |
| C. Embed-like (server only) | scraper `Referer`/`Cookie`/`Origin` | 200 server-side, fail B → **only full proxy works** |
| D. Credentials | `Origin` + `Cookie` | Cookie domain wrong in browser → hybrid still fails |

**Key insight:** Server probe **with** embed Referer proving 200 does **not** prove hybrid. You must probe with **the browser’s Origin/Referer** (or no forged Referer) to simulate hybrid.

### 3.4 In-browser probe (authoritative for hybrid)

From the player page (or a tiny test route on the same origin):

```js
async function probeSegmentCors(segmentUrl) {
  try {
    const res = await fetch(segmentUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit", // use "include" only if CDN cookie domain is CDN host
      headers: { Accept: "*/*" },
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 16) return { ok: false, reason: "empty_body" };
    return { ok: true, bytes: buf.byteLength, acao: res.headers.get("access-control-allow-origin") };
  } catch (e) {
    return { ok: false, reason: "cors_or_network", message: String(e) };
  }
}
```

- `TypeError` / “Failed to fetch” after network 200 in DevTools → almost always **CORS**.
- Status 200 in Network tab **with** CORS error is classic: response arrived, JS blocked.

### 3.5 Classify CDN capability

```
probe(segment, origin=app):
  if network fail / timeout → UNKNOWN (retry / full proxy safe default)
  if status 401/403 with app Origin/Referer → AUTH_OR_HOTLINK → FULL_PROXY
  if status 200/206 and ACAO allows app → HYBRID_OK
  if status 200/206 and no ACAO → CORS_BLOCK → FULL_PROXY
  if ACAO * and cookies required → FULL_PROXY (or signed-URL-only hybrid)
```

Cache classification **per CDN host** (TTL minutes–hours), not per segment, but re-probe on first playback error.

### 3.6 What about `Access-Control-Allow-Origin: *` on segments but not keys?

Partial hybrid: segments direct, keys proxied. Still a win if segments are 99% of bytes.

---

## 4. Decision tree

```
                    ┌─────────────────────────────┐
                    │ Have stream URL + session   │
                    │ (referer, cookies, UA)      │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │ Fetch master m3u8 (server)  │
                    │ Always via proxy session    │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │ Resolve first media playlist│
                    │ + first segment URL (+ key) │
                    └──────────────┬──────────────┘
                                   ▼
              ┌────────────────────┴────────────────────┐
              │ Segment probe as BROWSER would send it  │
              │ Origin: app, Referer: app (no embed)    │
              │ mode: cors, credentials: omit|include   │
              └────────────────────┬────────────────────┘
                                   ▼
              ┌────────────────────┴────────────────────┐
              │                                         │
        FAIL (403/CORS/no ACAO)                  PASS (200 + ACAO)
              │                                         │
              ▼                                         ▼
   ┌──────────────────────┐              ┌──────────────────────────┐
   │ FULL PROXY REQUIRED  │              │ Optional: key probe      │
   │ Rewrite ALL URIs →   │              │ fail key CORS?           │
   │ /api/hls/{sid}?u=…   │              └───────────┬──────────────┘
   │ Inject session auth  │                    fail  │  pass
   └──────────────────────┘                      │   │
              ▲                                  ▼   ▼
              │                    ┌─────────────────────────────┐
              │                    │ HYBRID:                      │
              │                    │ • Proxy master + media m3u8  │
              │                    │ • Absolutize segment URIs    │
              │                    │ • Leave segments on CDN      │
              │                    │ • Proxy KEY/MAP if needed    │
              │                    └──────────────┬──────────────┘
              │                                   ▼
              │                    ┌─────────────────────────────┐
              │                    │ Playback error (frag load)?  │
              │                    └──────────────┬──────────────┘
              │                         yes       │ no
              └───────────────────────────────────┘   ▼
                                         ┌────────────────────┐
                                         │ Stay hybrid        │
                                         │ (bandwidth win)    │
                                         └────────────────────┘
```

### Decision summary table

| Condition | Mode |
|-----------|------|
| CDN `ACAO *` or allows app origin; no cookies; no Referer lock; tokens in URL | **Hybrid** |
| Same + AES key CORS fails | **Hybrid + proxy keys** |
| Referer/Origin hotlink (Vidking/VidLink-style) | **Full proxy** |
| Cookies only on embed domain | **Full proxy** |
| Signed cookies on CDN domain + ACAC + exact ACAO + `withCredentials` | **Hybrid possible** (rare for third-party scrapes) |
| Unknown / probe timeout | **Full proxy** (safe default) |
| Live playlist needs constant refresh + auth headers | **At least proxy media m3u8**; segments hybrid only if probe passes |

---

## 5. CineHome implementation sketch (rewrite only if needed)

### 5.1 Current state

`cinehome-patches/hls-proxy.ts` always:

- Fetches upstream with session `Referer` / `Origin` / `Cookie` / UA
- `rewriteM3u8`: **every** URI line + `URI="..."` → `proxyUrlFor(sessionId, abs)`
- Same for MPD media/init/BaseURL

That is **full proxy**. Correct for referer-locked CDNs; expensive for bandwidth and server CPU.

### 5.2 Add capability flags on `HlsSession`

```ts
type ProxyMode = "full" | "hybrid";

interface HlsSession {
  // existing: id, rootUrl, referer, origin, cookies, userAgent, extraHeaders...
  proxyMode: ProxyMode;
  segmentHostsHybrid: string[]; // hosts allowed for direct browser fetch
}
```

### 5.3 Probe once when creating the session

```ts
async function classifyProxyMode(session, mediaPlaylistUrl): Promise<ProxyMode> {
  const pl = await curlGet(mediaPlaylistUrl, { headers: sessionHeaders(session) });
  const segmentUrl = firstSegmentAbsolute(pl.text, mediaPlaylistUrl);
  if (!segmentUrl) return "full";

  // Browser-like: do NOT send embed referer/cookies
  const probe = await curlGet(segmentUrl, {
    headers: {
      Origin: APP_ORIGIN,
      Referer: APP_ORIGIN + "/",
      "User-Agent": session.userAgent,
      Accept: "*/*",
    },
    timeoutSec: 10,
  });

  const acao = probe.headers["access-control-allow-origin"] ?? "";
  const acaoOk = acao === "*" || acao === APP_ORIGIN;
  if (probe.ok && acaoOk && probe.body.byteLength > 0) {
    return "hybrid";
  }
  return "full";
}
```

Optional second probe with embed headers only to confirm “server can fetch” (sanity), not for hybrid.

### 5.4 Dual rewrite paths

```ts
function rewriteM3u8(body: string, session: HlsSession, baseUrl: string): string {
  return body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          // Keys / maps: prefer proxy even in hybrid
          if (session.proxyMode === "hybrid" && isSegmentLike(abs) && !isKeyUri(trimmed)) {
            return `URI="${abs}"`;
          }
          return `URI="${proxyUrlFor(session.id, abs)}"`;
        });
      }
      return line;
    }

    const abs = resolveUrl(trimmed, baseUrl);
    if (session.proxyMode === "hybrid" && hostAllowed(abs, session)) {
      return abs; // browser → CDN direct
    }
    return proxyUrlFor(session.id, abs);
  }).join("\n");
}

function isKeyUri(tagLine: string): boolean {
  return tagLine.includes("EXT-X-KEY") || tagLine.includes("EXT-X-SESSION-KEY");
}
```

**Always proxy:** master URI in playback response, media playlist requests (so rewrites stay correct on live updates), key URIs, and anything that failed host allowlist.

### 5.5 Player side (hls.js)

For hybrid segments, default hls.js config is fine (CORS GET, no custom headers).

Do **not** set custom headers on CDN segment requests (triggers preflight → more CORS failure).

If a rare CDN needs cookies on the CDN host:

```ts
const hls = new Hls({
  xhrSetup(xhr, url) {
    if (url.startsWith("/api/hls/")) {
      xhr.withCredentials = true; // app session cookie for your proxy
    }
    // only if probe said ACAC + cookie domain is CDN:
    // if (isHybridCdn(url)) xhr.withCredentials = true;
  },
});
```

Full-proxy path: keep `withCredentials` for `/api/hls/` auth if you gate the proxy.

### 5.6 Runtime fallback

On `Hls.Events.ERROR` with `fragLoadError` / `manifestLoadError` for a hybrid session:

1. Flip `session.proxyMode = "full"` (server endpoint or new session).
2. Reload source with fully rewritten playlist.
3. Mark host as `full` in a short-lived host capability cache.

### 5.7 Host denylist / allowlist (pragmatic)

Given CineHome’s known hosts:

| Host pattern | Expected mode | Reason |
|--------------|---------------|--------|
| `storm.vodvidl.site` | **full** | Referer override to vidlink.pro |
| `*.hakunaymatata.com` | **full** | Same |
| `moon.ironbubble.site`, `infantinostreet.site`, `ironbubble.site` | **full** | Referer override to vidking |
| Public demo CDNs (`*.akamaihd.net` with `*`, Mux, etc.) | **hybrid** | Open CORS |
| Unknown new host | **probe → default full** | Safe |

You can short-circuit probe for denylisted hosts and always full-proxy.

### 5.8 Bandwidth / ops notes

| Mode | Server egress | Latency | Complexity |
|------|---------------|---------|------------|
| Full | All segment bytes | Extra hop | Simple, already built |
| Hybrid | Playlists + keys only (~KB) | Segments from CDN edge | Probe + dual rewrite + fallback |
| 302 segment redirect | Headers only | Extra RTT per segment; still needs CDN CORS **or** redirect to same-origin | Rarely better than hybrid for hls.js |

302 to CDN still requires **browser CORS against final segment URL** (redirect CORS rules apply). 302 does not bypass CORS.

### 5.9 DASH (`dash.js`) parity

Same tree: rewrite MPD to absolute CDN SegmentTemplate/BaseURL when CORS OK; otherwise proxy. CineHome `rewriteMpd` currently always proxies CDN hosts — same hybrid flag can gate `rewriteSegmentAttr`.

---

## 6. Answers to the four research questions

### Q1 — Rewrite m3u8, leave absolute CDN segments?

**Yes.** Server serves rewritten playlists; hls.js follows absolute segment URLs to the CDN. Nested media playlists should still be proxied (or carefully rewritten) so relatives never resolve against your domain incorrectly. Keys usually stay proxied.

### Q2 — When does this fail?

1. Missing/wrong CORS on segments (`ACAO`)  
2. Cookie/signed-cookie auth not visible to the app origin  
3. Referer/Origin hotlink protection  
4. IP-bound or playlist-bound auth  
5. Key URI CORS/auth failure  
6. Range/preflight/CORS cache misconfig  
7. `no-cors` attempts (always fail for MSE)  
8. Mixed content  

### Q3 — Detect CORS / “no-cors”?

- **`no-cors` does not indicate playability.**  
- Probe with `mode: 'cors'` (browser) or `curl -H 'Origin: …'` (server simulating browser).  
- Require **200/206 + usable `Access-Control-Allow-Origin` + readable body**.  
- Separately probe with embed Referer only to confirm server full-proxy path.  
- Classify per host; default **full** on doubt.

### Q4 — CineHome sketch

- Keep full proxy as default (matches current VidLink/Vidking reality).  
- Add `proxyMode: full | hybrid` on session.  
- Probe first segment with **app** Origin/Referer.  
- Hybrid rewrite: absolutize segments; proxy m3u8 + keys.  
- Deny hybrid for known referer-locked hosts without probing.  
- Fallback to full on first fragment CORS/403 error.

---

## 7. Recommendation for CineHome

| Priority | Action |
|----------|--------|
| **Now** | Keep **full proxy** for all scrapered embed CDNs — hybrid will fail on Referer + cookies for ironbubble / hakunaymatata / vodvidl. |
| **Optional optimization** | Host capability cache + hybrid for CDNs that return `ACAO *` without hotlink (public/licensed CDNs, self-hosted, some open mirrors). |
| **Do not** | Rely on `no-cors`, browser Referer spoofing, or 302-to-CDN as a CORS bypass. |
| **Do** | Always absolutize when leaving URIs off-proxy; always proxy AES keys unless key probe passes. |

**Bottom line:** Hybrid is a real, standard pattern (manifest manipulation with absolute segment URLs) and wins massive egress — but **only when the CDN opts into CORS for your site and does not require embed-only auth**. CineHome’s primary sources do not; treat hybrid as an opportunistic fast path behind a probe, not the default.

---

## References

- hls.js docs — CORS: all HLS resources need CORS for GET (readable by XHR/fetch + MSE).  
- MDN CORS — `ACAO`, credentials vs `*`, simple vs preflight.  
- Eyevinn `hls-proxy` — mediaManifestHandler leaving segments off-proxy vs segmentRedirectHandler.  
- CloudFront signed cookies vs signed URLs for multi-segment HLS.  
- CineHome `hls-proxy.ts` — full rewrite + `REFERER_OVERRIDES` for embed CDNs.  
- Opaque `no-cors` responses — body unusable for players.
