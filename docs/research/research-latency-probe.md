# Source Health Probe System — Research & Design

**Project:** CineHome  
**Date:** 2026-07-09  
**Scope:** Measure per-source TTFB + throughput from the home server, rank by measured speed (not provider name), cache 5–15 min.  
**Primary integration:** `mini-services/stream-scraper` (preferred) and/or Next playback path (`src/lib/playback`, HLS proxy).  
**SoT paths:** `/Users/husnainali/cinehome-sot/`

---

## 1. Problem statement

Today CineHome **verifies** sources (alive/dead) but **ranks** them with static heuristics:

| Layer | What it does | Gap |
|-------|----------------|-----|
| Scraper `verifyHlsServer` / `verifySourceEntry` | Boolean: manifest 200 + `#EXTM3U` + first seg >500B (or MP4 range 0–2047) | No latency / throughput |
| Scraper `entryScore` / `providerPriority` | Codec + resolution + **named** CDN tiers (Solstice +35, Pulse +15, Luna +5) | Assumes Solstice always fast |
| App `scoreSource` / `pickDefaultSource` | Same named-tier bias; `isFasterSource` is Solstice/Pulse vs Luna only | Cannot learn when Phoenix is faster than Solstice tonight |
| HLS proxy prefetch | Warms 8 segments **after** play starts for the chosen session | Too late for source selection |

Empirical comments in code (`Solstice ~90–300ms`, `Luna ~3.4s/seg`) prove ranking is based on one-time measurement, not continuous probes. CDN performance drifts; signed URLs rotate; household egress is what matters (probe **must** run on the home server, same network as the proxy).

**Goal:** When scrape returns N sources, before/during play:

1. HEAD or range-GET the first media segment (or small byte window) with correct `Referer` / `Origin` / cookies / UA.
2. Measure **TTFB** and **throughput**.
3. Rank by measured speed (with codec/quality secondary).
4. Cache probe results **5–15 minutes** (aligned with scrape `CACHE_TTL_MS = 15m`).

---

## 2. Current code anchors (do not reinvent)

### 2.1 Verification (boolean only)

```
mini-services/stream-scraper/index.ts
  VERIFY_TIMEOUT_SEC = 12
  verifyHlsServer(manifest, referer, ua, cookies) → boolean
  verifySourceEntry(entry) → boolean
  filterVerifiedEntries → Promise.all over all entries (unbounded concurrency)
  refererForCdn() / CDN_REFERERS map
```

### 2.2 HTTP transport

```
mini-services/stream-scraper/curl-http.ts
  curlGet(url, { headers, timeoutSec }) → { ok, status, body, text, headers }
  // No timing write-out; spawns curl per request; full body to temp file
```

App side mirrors: `src/lib/curl-http.ts`, HLS proxy uses Bun `fetch` with session headers (`src/lib/hls-proxy.ts` `buildUpstreamHeaders` + `REFERER_OVERRIDES`).

### 2.3 Ranking (name-based)

```
scraper: sortSourcesForDefault → providerPriority then entryScore
app:     pickDefaultSource → sourceFailoverPriority then scoreSource
```

### 2.4 Home server constraints

| Constraint | Value / implication |
|------------|---------------------|
| Single container | Next + scraper share network; scraper **not** published (`3030` internal only) |
| Browser pool | `MAX_BROWSERS = 2`, `shm_size: 2gb` |
| Concurrent scrapes | Pool wait up to 120s; probes must not starve Playwright |
| Household link | Probes compete with live playback + segment prefetch (8 segs) |
| Disk | Preflight aborts if free < 20GB; probes must stream to `/dev/null` or cap bytes |
| Process memory | Segment cache ~512MB; probes must not buffer multi-MB bodies |

---

## 3. Probe model

### 3.1 What we measure

| Metric | Definition | Why |
|--------|------------|-----|
| **TTFB** (`ttfbMs`) | Time from request start → first response byte (or headers complete) | Correlates with “start play” feel; isolates connect/TLS/CDN edge |
| **Throughput** (`bytesPerSec`) | `bytesReceived / transferMs` after first byte (or total time if tiny body) | Correlates with rebuffer risk at 1080p/4K |
| **OK** | HTTP 2xx/206 + minimum bytes + content sanity | Replaces pure boolean verify |
| **Error class** | `timeout` \| `http` \| `tls` \| `hotlink` \| `empty` \| `redirect_loop` \| `dns` | Soft-fallback policy |

**Composite speed score** (higher = better, used for sort):

```
speedScore =
  0.55 * ttfbScore +
  0.45 * thruputScore

ttfbScore    = clamp(0, 100, 100 * (TTFB_GOOD_MS / max(ttfbMs, 1)))
thruputScore = clamp(0, 100, 100 * (bytesPerSec / THRUPUT_GOOD_BPS))

// Defaults tuned for home-server egress to consumer CDNs:
TTFB_GOOD_MS     = 250     // "excellent" TTFB target
THRUPUT_GOOD_BPS = 2_500_000  // ~20 Mbps good enough for 1080p ABR
```

**Final rank score** (still respects codec, not provider name):

```
rankScore =
  speedScore * 10           // primary: measured path quality
  + codecBonus              // H264 HLS +40, HEVC −80 (existing policy)
  + resolutionBonus         // 1080p +35, 720p +20, 4K +50 (existing)
  − failurePenalty          // dead/timeout last

// Explicitly: NO Solstice/Pulse/Luna name bonuses in rankScore.
// Provider labels remain for UI only.
```

User preference (`cinehome:preferred-provider`) stays as a **hard override** (+200) only when the preferred source is `ok` and not timed out — never force a dead preferred server.

### 3.2 Probe target selection (per source type)

```
function resolveProbeTarget(entry): ProbeTarget
```

| Source type | Step A | Step B (measured) | Fallback if B fails |
|-------------|--------|-------------------|---------------------|
| **HLS** `.m3u8` | GET master/media playlist (full, small) | Range-GET **first media segment** `bytes=0–(PROBE_RANGE_END)` | If playlist has only variants, pick first `#EXT-X-STREAM-INF` URI → media playlist → first seg |
| **DASH** `.mpd` | GET MPD XML | Range-GET first Representation init or media URL | If no parseable URL, range-GET MPD host root fails → `ok=false` |
| **MP4** progressive | — | Range-GET `bytes=0–(PROBE_RANGE_END)` (same as today 0–2047, but larger for thruput) | HEAD only if range rejected |

**Never** probe with a bare HEAD against HLS segment CDNs as the *only* signal: many CDNs return 200 on HEAD with wrong auth, or 403 on HEAD while GET works (and vice versa). Algorithm:

```
prefer: GET with Range: bytes=0-N   (N = PROBE_BYTE_CAP - 1)
if response status in {405, 416, 501} OR Accept-Ranges: none:
  fallback: GET without Range, abort after PROBE_BYTE_CAP bytes
if HEAD-only mode enabled AND host in HEAD_SAFE_HOSTS:
  optional preflight HEAD for cheap dead-check (not for thruput)
```

### 3.3 Headers (critical — match proxy)

Reuse scraper + proxy maps so probe sees the same path as play:

```
Referer: refererForCdn(targetUrl, session.referer)  // CDN_REFERERS / REFERER_OVERRIDES
Origin:  origin of effective Referer
User-Agent: session.userAgent || DEFAULT_UA
Cookie: session.cookies (if any)
Accept: */*
Range: bytes=0-{PROBE_BYTE_CAP-1}   // segment / mp4 path only
```

**Do not** strip cookies “to be nice” — ironbubble / vidking paths often need them (see existing `test-seg.ts`).

### 3.4 Byte and time budgets

| Constant | Default | Rationale |
|----------|---------|-----------|
| `PROBE_BYTE_CAP` | **65536** (64 KiB) | Enough for thruput estimate; cheap on disk/CPU |
| `PROBE_RANGE` | `bytes=0-65535` | Matches cap |
| `PROBE_MIN_BYTES_OK` | **500** (HLS/seg), **200** (MP4) | Align with current verify thresholds |
| `PROBE_CONNECT_TIMEOUT_MS` | **3000** | Fail fast on dead edge |
| `PROBE_TTFB_TIMEOUT_MS` | **5000** | If no first byte by 5s → unusable for play |
| `PROBE_TOTAL_TIMEOUT_MS` | **8000** | Hard wall per source (replace 12s verify for rank path) |
| `PROBE_CACHE_TTL_MS` | **10 * 60 * 1000** (10 min) | Mid of 5–15; clamp per signed `expires` |
| `PROBE_CACHE_TTL_MIN_MS` | 5 min | Floor |
| `PROBE_CACHE_TTL_MAX_MS` | 15 min | Ceiling |
| `PROBE_MAX_CONCURRENT` | **3** | Home-server safe (see §6) |
| `PROBE_MAX_PER_SCRAPE` | **8** | Cap work when scrape returns 12 sources |
| `PROBE_GLOBAL_BUDGET_MS` | **12000** | Entire batch wall clock; rank with partial results |

Playlist fetch for HLS is **not** counted as thruput sample (too small / text). Only the **segment range** (or MP4 range) feeds `bytesPerSec`. Playlist fetch still contributes a separate `playlistTtfbMs` for diagnostics.

---

## 4. Concrete algorithm

### 4.1 Pipeline placement

```
scrape providers
    → mergeSourceEntries (identity dedupe)
    → [optional] boolean prefilter (cheap HEAD/playlist only) OR skip if time-tight
    → probeSources(entries)          // NEW: concurrent limited health probes
    → sortByProbeThenCodec(entries)  // NEW: measured rank
    → buildMergedResult → streamUrl = sources[0]
```

**When to run**

| Mode | Behavior |
|------|----------|
| `fast=1` (Luna-first) | **Skip full multi-source probe** or probe only the 1 returned source (confirm alive). TTFF > rank accuracy. |
| Full scrape / enrich complete | Probe up to `PROBE_MAX_PER_SCRAPE` top identity-unique entries. |
| Background enrich adds sources | Probe **new** identities only; merge into cache; client may re-rank via `isFasterSource` replaced by probe rank. |
| Client mid-play failover | Prefer cached probe order; if cache miss, lazy-probe next 1–2 candidates (not all N). |

### 4.2 Pseudocode — single source

```ts
async function probeOne(entry: SourceEntry, opts: ProbeOptions): Promise<ProbeResult> {
  const cacheKey = probeCacheKey(entry);
  const cached = probeCache.get(cacheKey);
  if (cached && !cached.stale && Date.now() < cached.expiresAt) {
    return { ...cached.result, fromCache: true };
  }

  const headers = buildProbeHeaders(entry);
  const started = performance.now();

  try {
    if (isHls(entry.url)) {
      const pl = await timedGet(entry.url, headers, opts.playlistTimeoutMs);
      if (!pl.ok || !pl.text.includes("#EXTM3U")) {
        return fail(entry, "http" | "empty", started);
      }
      const segUrl = firstMediaSegmentUrl(pl.text, entry.url); // resolve variants if needed
      if (!segUrl) return fail(entry, "empty", started);

      const seg = await timedRangeGet(segUrl, headers, PROBE_BYTE_CAP, opts);
      return finalize(entry, seg, pl.ttfbMs);
    }

    if (isDash(entry.url)) {
      const mpd = await timedGet(entry.url, headers, opts.playlistTimeoutMs);
      if (!mpd.ok || !mpd.text.includes("<MPD")) return fail(entry, "http", started);
      const mediaUrl = firstDashMediaUrl(mpd.text, entry.url) ?? entry.url;
      const seg = await timedRangeGet(mediaUrl, headers, PROBE_BYTE_CAP, opts);
      return finalize(entry, seg, mpd.ttfbMs);
    }

    // progressive MP4 / direct
    const seg = await timedRangeGet(entry.url, headers, PROBE_BYTE_CAP, opts);
    return finalize(entry, seg, undefined);
  } catch (e) {
    return fail(entry, classifyError(e), started);
  }
}
```

### 4.3 Timed range-GET (implementation options)

**Preferred on scraper host: curl with write-out** (already depend on curl):

```bash
curl -sS -L --compressed \
  --connect-timeout 3 --max-time 8 \
  -H "Referer: ..." -H "Origin: ..." -H "User-Agent: ..." -H "Range: bytes=0-65535" \
  -o /dev/null \
  -w "%{http_code} %{time_starttransfer} %{time_total} %{size_download} %{speed_download}" \
  "$URL"
```

Parse:

```
status            = http_code
ttfbMs            = time_starttransfer * 1000
totalMs           = time_total * 1000
bytes             = size_download
bytesPerSec       = speed_download  // curl already computes
// or: bytes / max(time_total - time_starttransfer, 0.001)
```

**Bun/Node fetch alternative** (Next path / if curl spawn cost matters):

```ts
const t0 = performance.now();
const res = await fetch(url, { headers, signal: AbortSignal.timeout(TOTAL) });
const tHeaders = performance.now(); // ≈ TTFB if body not yet read
const reader = res.body.getReader();
let bytes = 0;
let tFirst = 0;
while (bytes < PROBE_BYTE_CAP) {
  const { done, value } = await reader.read();
  if (done) break;
  if (!tFirst) tFirst = performance.now();
  bytes += value.byteLength;
}
reader.cancel();
const ttfbMs = (tFirst || tHeaders) - t0;
const thruputMs = performance.now() - (tFirst || tHeaders);
const bytesPerSec = bytes / Math.max(thruputMs / 1000, 0.001);
```

**Recommendation:** extend `curl-http.ts` → `curlProbe()` with `-w` timings and `-o /dev/null` (no temp files). Keep `curlGet` for playlist text. Spawn cost is OK at N≤8 with concurrency 3.

### 4.4 HLS first-segment resolution

```
1. GET playlist P
2. If P is master (has #EXT-X-STREAM-INF):
     pick variant:
       - prefer middle bandwidth (not highest 4K that will thrash probe)
       - or first non-HEVC codec line if CODECS= present
     GET media playlist M
3. Else M = P
4. First non-# line that looks like media (.ts .m4s .mp4 or relative path)
5. Resolve absolute URL against M's URL
6. Range-GET that segment
```

**Master variant pick (to reduce false “slow” on 4K variants):**

```
candidates = parse STREAM-INF
prefer: HEIGHT <= 1080 if present
else: BANDWIDTH closest to 4_000_000
else: first entry
```

Probing the 4K variant of a fast CDN can look “slow” and lose to a 720p slow CDN — hence resolution remains a **separate** rank term, and thruput is normalized optionally:

```
// Optional fairness (v2):
effectiveThruput = bytesPerSec / max(1, expectedBitrateFactor(height))
```

v1: skip normalization; cap probe at 64 KiB so 4K vs 720p difference is mostly TTFB/edge, not full segment size.

### 4.5 Batch algorithm with concurrency limit

```ts
async function probeSources(entries: SourceEntry[]): Promise<ProbedSource[]> {
  const rankedHint = sortByCodecOnly(entries).slice(0, PROBE_MAX_PER_SCRAPE);
  const results: ProbedSource[] = [];
  const queue = [...rankedHint];
  const deadline = Date.now() + PROBE_GLOBAL_BUDGET_MS;

  await mapPool(queue, PROBE_MAX_CONCURRENT, async (entry) => {
    if (Date.now() > deadline) {
      results.push({ entry, result: skipped("budget") });
      return;
    }
    const result = await probeOne(entry, timeouts);
    probeCache.set(probeCacheKey(entry), result, ttlFor(entry, result));
    results.push({ entry, result });
  });

  // Sources not probed (over cap): keep with speedScore=null, sort after probed-ok
  for (const e of entries) {
    if (!results.find(r => sameIdentity(r.entry, e))) {
      results.push({ entry: e, result: skipped("not_selected") });
    }
  }

  return sortProbed(results);
}

function sortProbed(items: ProbedSource[]): ProbedSource[] {
  return items.sort((a, b) => {
    // 1. ok before !ok
    if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1;
    // 2. non-HEVC before HEVC
    if (hevc(a) !== hevc(b)) return hevc(a) ? 1 : -1;
    // 3. measured speedScore (nulls last among ok)
    const sa = a.result.speedScore ?? -1;
    const sb = b.result.speedScore ?? -1;
    if (sa !== sb) return sb - sa;
    // 4. resolution / container only — NO provider name
    return codecResScore(b.entry) - codecResScore(a.entry);
  });
}
```

`mapPool` = classic worker pool (max 3 in flight).

### 4.6 Soft-fallback (preserve current reliability)

Current behavior: if **all** probes fail, soft-keep top 3 candidates so flaky verify cannot empty the roster.

Keep that:

```
if (probed.every(p => !p.result.ok)):
  log warn
  return softKeep(entries, 3)  // no speedScore; fall back to codec/res only
```

Never delete all sources because home DNS blipped.

### 4.7 Cache key and TTL

```ts
function probeCacheKey(entry: SourceEntry): string {
  // Host + path without volatile query where possible; include identity
  const u = new URL(entry.url);
  const pathKey = `${u.hostname}${u.pathname}`;
  // Signed URLs: include expires bucket so we don't reuse dead signatures
  const exp = u.searchParams.get("expires") ?? "";
  return sha256(`${entryIdentity(entry)}|${pathKey}|${exp}`).slice(0, 32);
}

function ttlFor(entry, result): number {
  let ttl = PROBE_CACHE_TTL_MS; // 10m default
  if (!result.ok) ttl = Math.min(ttl, 2 * 60_000); // fail cache short (2m) — retry sooner
  // signed URL remaining life
  const signed = remainingSignedTtlMs(entry.url); // existing cacheTtlFor logic
  if (signed > 0) ttl = Math.min(ttl, signed);
  return clamp(ttl, PROBE_CACHE_TTL_MIN_MS, PROBE_CACHE_TTL_MAX_MS);
}
```

**In-memory only** (Map) on scraper process — same as circuits / scrape cache. Acceptable for household; resets on restart (cold start re-probes).

Optional v2: attach probe summary to scrape result cache entry so warm scrape hits also return last speed ranks without re-probe.

### 4.8 Response shape (additive API)

Extend scrape sources (and then `PlaybackSource`) without breaking clients:

```ts
// Additive on each source in ScrapeResult / PlaybackResponse
probe?: {
  ok: boolean;
  ttfbMs: number | null;
  bytesPerSec: number | null;
  speedScore: number | null;  // 0–100
  probedAt: number;           // epoch ms
  fromCache: boolean;
  errorClass?: ProbeErrorClass;
};
```

`streamUrl` = first after `sortProbed`. Client `pickDefaultSource` should prefer `probe.speedScore` when present (see §8).

---

## 5. TypeScript interfaces

Place in `mini-services/stream-scraper/probe.ts` (new) and mirror summary types in `src/lib/playback/types.ts`.

```typescript
/** Error taxonomy for probes (and logs /health). */
export type ProbeErrorClass =
  | "timeout"
  | "http"
  | "tls"
  | "dns"
  | "hotlink"      // 403/401 with body hint
  | "empty"        // 200 but < min bytes or no segment
  | "redirect_loop"
  | "parse"        // m3u/mpd unusable
  | "budget"       // global batch budget / not selected
  | "unknown";

export type ProbeMethod = "range_get" | "get_abort" | "head" | "playlist_only";

export interface ProbeSessionHeaders {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders?: Record<string, string>;
}

/** Input: one scrape source. */
export interface ProbeRequest {
  /** Stable UI/server identity: provider|label */
  identity: string;
  url: string;
  provider: string;
  label: string;
  quality: string;
  type: "hls" | "mp4" | "dash";
  session: ProbeSessionHeaders;
}

export interface ProbeTiming {
  /** ms to first body byte (or headers if body empty). */
  ttfbMs: number;
  /** ms wall for capped transfer after first byte. */
  transferMs: number;
  /** total wall ms including connect. */
  totalMs: number;
  bytes: number;
  bytesPerSec: number;
  httpStatus: number;
  method: ProbeMethod;
  /** Resolved media URL actually timed (segment), if different from playlist. */
  targetUrl?: string;
  playlistTtfbMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  identity: string;
  url: string;
  timing: ProbeTiming | null;
  /** 0–100 composite; null if skipped/failed without sample. */
  speedScore: number | null;
  errorClass?: ProbeErrorClass;
  errorMessage?: string;
  probedAt: number;
  fromCache: boolean;
  expiresAt: number;
}

export interface ProbedSource {
  request: ProbeRequest;
  result: ProbeResult;
  /** Final rank key used for sort (higher better). */
  rankScore: number;
}

export interface ProbeBatchOptions {
  maxConcurrent?: number;      // default 3
  maxSources?: number;         // default 8
  globalBudgetMs?: number;     // default 12_000
  connectTimeoutMs?: number;   // default 3_000
  ttfbTimeoutMs?: number;      // default 5_000
  totalTimeoutMs?: number;     // default 8_000
  byteCap?: number;            // default 65_536
  cacheTtlMs?: number;         // default 600_000
  skipCache?: boolean;
}

export interface ProbeBatchResult {
  probed: ProbedSource[];
  /** sources[0] identity after sort */
  winnerIdentity: string | null;
  stats: {
    total: number;
    ok: number;
    failed: number;
    cached: number;
    skipped: number;
    wallMs: number;
    concurrency: number;
  };
}

export interface ProbeCacheSnapshot {
  size: number;
  hits: number;
  misses: number;
  oldestExpiresAt: number | null;
}

/** curl / fetch low-level sample. */
export interface TimedHttpSample {
  ok: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  bytesPerSec: number;
  /** filled only when body retained (playlists). */
  text?: string;
  headers: Record<string, string>;
  errorClass?: ProbeErrorClass;
}

export interface CurlProbeOptions {
  headers?: Record<string, string>;
  connectTimeoutSec?: number;
  maxTimeSec?: number;
  /** If set, send Range and discard body (timings only). */
  rangeEnd?: number; // inclusive; bytes=0-rangeEnd
  /** If true, -o /dev/null; if false, capture text (playlists). */
  discardBody?: boolean;
  maxBytes?: number;
}

/** Extend existing SourceEntry without breaking scrape. */
export interface SourceEntryWithProbe {
  url: string;
  quality: string;
  label: string;
  provider: string;
  session: {
    referer: string;
    origin: string;
    userAgent: string;
    cookies: string;
    extraHeaders: Record<string, string>;
  };
  probe?: {
    ok: boolean;
    ttfbMs: number | null;
    bytesPerSec: number | null;
    speedScore: number | null;
    probedAt: number;
    fromCache: boolean;
    errorClass?: ProbeErrorClass;
  };
}

/** Playback API additive fields (src/lib/playback/types.ts). */
export interface PlaybackSourceProbe {
  ok: boolean;
  ttfbMs: number | null;
  bytesPerSec: number | null;
  speedScore: number | null;
  probedAt: number;
}

// PlaybackSource extension:
// probe?: PlaybackSourceProbe;

export interface ProbeService {
  probeOne(req: ProbeRequest, opts?: ProbeBatchOptions): Promise<ProbeResult>;
  probeBatch(reqs: ProbeRequest[], opts?: ProbeBatchOptions): Promise<ProbeBatchResult>;
  getCacheStats(): ProbeCacheSnapshot;
  invalidate(identity?: string): void;
}
```

### 5.1 curl helper extension

```typescript
// mini-services/stream-scraper/curl-http.ts (additive)

export async function curlProbe(
  url: string,
  options: CurlProbeOptions = {}
): Promise<TimedHttpSample> {
  // spawn curl with:
  // -w "%{http_code}\t%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{speed_download}\t%{url_effective}"
  // --connect-timeout, --max-time
  // optional -r 0-N  (curl range) or -H "Range: bytes=0-N"
  // -o /dev/null when discardBody
  // parse stdout tab fields → TimedHttpSample
}
```

### 5.2 Optional HTTP routes (scraper)

Keep scraper unpublished; only Next calls it.

| Route | Purpose |
|-------|---------|
| Existing `GET /scrape` | Run probe batch at end of full resolve; attach `probe` on sources |
| `POST /probe` | Body: `{ sources: ProbeRequest[] }` → `ProbeBatchResult` (for re-rank without full scrape) |
| `GET /health` | Add `probe: { cache, lastBatchWallMs, lastOkRate }` |

```typescript
// POST /probe body
export interface ProbeHttpRequest {
  sources: ProbeRequest[];
  options?: ProbeBatchOptions;
}

// GET /health extension
export interface HealthProbeSection {
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  lastBatch?: {
    at: number;
    wallMs: number;
    ok: number;
    failed: number;
    concurrency: number;
  };
}
```

---

## 6. Concurrent probe limits on the home server

### 6.1 Why not `Promise.all` on all N

Current `filterVerifiedEntries` already does unbounded `Promise.all`. That is risky when:

- N = 12 sources × (playlist + segment) = up to 24 outbound HTTPS
- Live user is mid-play (proxy prefetch 8 segments)
- Second household member starts another title
- Playwright browsers (2) still running for enrich

### 6.2 Recommended limits (v1 defaults)

| Knob | Value | Notes |
|------|-------|-------|
| `PROBE_MAX_CONCURRENT` | **3** | Sweet spot: fills 3 TCP/TLS without drowning 100–300 Mbps home uplinks or CDN rate limits |
| `PROBE_MAX_PER_SCRAPE` | **8** | Probe best 8 by codec/res pre-score; rest unranked |
| `PROBE_GLOBAL_BUDGET_MS` | **12_000** | Align with old VERIFY 12s wall; return partial ranks |
| In-flight global (all scrapes) | **4** | Process-wide semaphore so two scrapes don't each run 3 (→6) |
| Per-host concurrent | **2** | Same CDN hostname; avoid burst bans |
| During active playback sessions | optional **2** | If `hls-session` count > 0, lower concurrency (v2) |

### 6.3 Process-wide semaphore sketch

```typescript
const globalProbeSlots = createSemaphore(4);

async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  await globalProbeSlots.acquire();
  try {
    return await fn();
  } finally {
    globalProbeSlots.release();
  }
}
```

### 6.4 Bandwidth budget

Worst case v1:

```
3 concurrent × 64 KiB = 192 KiB per wave
8 sources / 3 ≈ 3 waves → ~576 KiB download per full scrape probe
At 50 Mbps: transfer << 1s; dominated by TTFB/timeouts
```

Negligible vs continuous 1080p stream (~5–8 Mbps). **Timeouts** are the real cost (thread/socket hold), hence hard `max-time 8`.

### 6.5 CPU / spawn cost

`curl` spawn per request: ~5–15ms overhead on Linux.  
8 sources × ~2 curls (playlist+seg) = 16 spawns ≈ 100–200ms overhead total — acceptable.  
If measured high, switch segment probes to Bun `fetch` and keep curl only if TLS fingerprinting ever matters (today scraper’s curl is for reliability, not JA3).

### 6.6 Interaction with Playwright pool

Probes must **never** take a browser from `withBrowser`. Pure HTTP only.  
If scrape enrich and probe overlap: probe runs **after** merge of that wave, or on a background microtask with global semaphore so browsers stay free.

---

## 7. False positives / false negatives

### 7.1 False “healthy” (probe OK, play fails)

| Cause | Mitigation |
|-------|------------|
| Playlist 200 + first seg 200 but later segments 403 (token rotation) | Session TTL 25m already; on proxy 403 mark source failed + failover; shorten probe cache for hosts with `expires` |
| Probe uses wrong quality variant; play picks higher ABR rung that is blocked | Probe middle rung; player still ABR; failover handles |
| CDN allows small Range but full segment GET blocked | Rare; if play fails immediately, negative cache that identity 2m |
| Hotlink checks IP of browser vs server (probe from server OK, client direct fail) | **N/A for CineHome** — all media goes through server HLS proxy; probe IP == play IP |
| Probe cached across signature expiry | TTL min(signed remaining, cache); parse `expires` query |
| `#EXTM3U` ad/pre-roll playlist with tiny seg then dead content | Prefer segs with typical media extensions; if thruput absurdly high + bytes tiny, still ok — play failover |
| 206 Partial with empty body counted ok | Enforce `bytes >= PROBE_MIN_BYTES_OK` |

### 7.2 False “unhealthy” (probe fail, play would work)

| Cause | Mitigation |
|-------|------------|
| HEAD not supported → 403/405 | Prefer Range-GET; HEAD only optional |
| Missing Referer/Origin/Cookie | Share `refererForCdn` + session with proxy exactly |
| Timeout too aggressive on cold TLS | connect 3s / total 8s; soft-keep top 3 if all fail |
| Master playlist only; relative seg resolve bug | Use playlist URL as base; cover multi-level masters in tests |
| IPv6 broken path; player uses v4 | curl `-4` force if dual-stack issues seen on server |
| Rate limit from probing too hard | concurrency 3, per-host 2, cache 10m |
| Cloudflare challenge on GET | Same as play path — if probe fails, play fails via proxy too; soft-keep |
| Byte cap aborted connection logged as error by CDN | Prefer Range so server closes cleanly with 206 |

### 7.3 False ranking (A ranked over B but B plays smoother)

| Cause | Mitigation |
|-------|------------|
| 64 KiB sample noise / TCP slow start | Weight TTFB 55%; average 2 samples only if `speedScore` within 10 pts and budget remains (v2) |
| Congestion from concurrent probes | Stagger or limit concurrency; don't probe while heavy prefetch if needed |
| Comparing 4K edge to 720p edge | Variant pick ≤1080p for probe; resolution separate term |
| Cached rank while CDN degraded | TTL 10m; fail cache 2m; player fatal error invalidates identity |
| Geographic anycast shift | Next probe cycle corrects; no sticky provider name |

### 7.4 Soft-keep risk

Soft-keeping unverified top-3 can put a dead URL first. Acceptable (current product choice). With probes: soft-keep only when **batch-wide** failure; if ≥1 ok, never soft-keep failures above ok sources.

---

## 8. Ranking integration (replace name-based speed)

### 8.1 Scraper `sortSourcesForDefault`

Replace providerPriority speed tiers with:

```
ok probe desc → non-HEVC → speedScore desc → resolution/container score
```

Delete or zero-out:

```
// scoreSourceEntry name bonuses — REMOVE for rank path:
// if vidking/solstice +35
// if notorrent/pulse +15
// if vixsrc/luna +5
```

Keep codec/res math. Labels (Solstice, Luna, …) remain display-only.

### 8.2 App `pickDefaultSource` / `isFasterSource`

```typescript
export function probeRank(source: PlaybackSource): number | null {
  return source.probe?.ok ? source.probe.speedScore : null;
}

export function isFasterSource(current: PlaybackSource, candidate: PlaybackSource): boolean {
  if (current.id === candidate.id) return false;
  const a = probeRank(current);
  const b = probeRank(candidate);
  if (a != null && b != null) {
    // material upgrade only — avoid flapping
    return b >= a + 8; // ~8 points on 0–100 scale
  }
  // Fallback legacy CDN class only if neither has probe data
  if (a == null && b == null) {
    return isSlowCdnSource(current) && isFastCdnSource(candidate);
  }
  // Prefer probed-ok over unprobed or failed
  if (b != null && a == null) return true;
  return false;
}
```

### 8.3 Fast path policy

- Fast Luna return: optional single probe; if `ttfbMs > 2000` or fail, still return URL (TTFF) but mark `probe.ok=false` so enrich winner can auto-switch sooner.
- After enrich+probe: `isFasterSource` upgrades mid-play when candidate speedScore wins.

---

## 9. Timeouts summary

```
┌─────────────────────────────────────────────────────────┐
│  PROBE_GLOBAL_BUDGET_MS = 12000  (batch wall)           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ per source PROBE_TOTAL_TIMEOUT_MS = 8000          │  │
│  │  connect ≤ 3000                                   │  │
│  │  TTFB   ≤ 5000  (abort if no first byte)          │  │
│  │  transfer until byteCap or total timeout          │  │
│  └───────────────────────────────────────────────────┘  │
│  cache TTL 5–15 min (default 10; fail 2 min)            │
└─────────────────────────────────────────────────────────┘
```

Compare to today: `VERIFY_TIMEOUT_SEC = 12` per sequential-ish verify step; HLS verify can do 2 full downloads (manifest + full first segment **unlimited size**). Probe is **stricter time, smaller bytes**, better signal.

---

## 10. Where to implement (recommendation)

| Option | Pros | Cons |
|--------|------|------|
| **A. Scraper-only (recommended v1)** | Same host as verify; has sessions; single place for rank before `streamUrl`; `/health` metrics | Full scrape latency +0.5–3s in worst case (often cache) |
| B. Next playback API after scrape | Closer to proxy fetch code | Duplicates referer maps; +RRT to 3030 already paid; couples rank to request path |
| C. Dual (scraper rank + Next re-probe) | Freshest | Double bandwidth; avoid |

**v1 plan:** Option A in `mini-services/stream-scraper`:

1. `curl-http.ts` → add `curlProbe`
2. New `probe.ts` — cache, mapPool, HLS seg resolve, rankScore
3. `index.ts` — replace/extend `filterVerifiedEntries` with probe batch; sort by speedScore
4. Attach `probe` on returned sources
5. `src/lib/playback/scraper.ts` — map probe → `PlaybackSource.probe`
6. `source-quality.ts` — rank by probe when present
7. Health snapshot fields
8. Tests: unit for rank math + m3u first-seg parse; integration with fixture playlist

**Do not** block `fast=1` on multi-probe.

---

## 11. Observability

Log (structured, `SCRAPER_LOG_LEVEL=debug`):

```
[probe] identity=vidking|Solstice ok=1 ttfb=120 thruput=8500000 score=94 cache=0
[probe] identity=vixsrc|Luna ok=1 ttfb=3100 thruput=900000 score=22 cache=0
[probe] batch n=5 ok=4 fail=1 wallMs=1840 conc=3 cached=1
```

`/health` includes last batch + cache size.  
Smoke harness (`scripts/smoke-playback.ts`): optional assert `sources[0].probe.ok === true` when probe field present.

---

## 12. Algorithm constants (copy-paste)

```typescript
export const PROBE_BYTE_CAP = 65_536;
export const PROBE_MIN_BYTES_HLS = 500;
export const PROBE_MIN_BYTES_MP4 = 200;
export const PROBE_CONNECT_TIMEOUT_MS = 3_000;
export const PROBE_TTFB_TIMEOUT_MS = 5_000;
export const PROBE_TOTAL_TIMEOUT_MS = 8_000;
export const PROBE_GLOBAL_BUDGET_MS = 12_000;
export const PROBE_MAX_CONCURRENT = 3;
export const PROBE_GLOBAL_MAX_INFLIGHT = 4;
export const PROBE_MAX_PER_HOST = 2;
export const PROBE_MAX_PER_SCRAPE = 8;
export const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
export const PROBE_CACHE_TTL_MIN_MS = 5 * 60 * 1000;
export const PROBE_CACHE_TTL_MAX_MS = 15 * 60 * 1000;
export const PROBE_FAIL_CACHE_TTL_MS = 2 * 60 * 1000;
export const PROBE_TTFB_GOOD_MS = 250;
export const PROBE_THRUPUT_GOOD_BPS = 2_500_000;
export const PROBE_TTFB_WEIGHT = 0.55;
export const PROBE_THRUPUT_WEIGHT = 0.45;
export const PROBE_UPGRADE_MARGIN = 8; // speedScore points to auto-switch
export const PROBE_VARIANT_MAX_HEIGHT = 1080;
export const PROBE_VARIANT_TARGET_BANDWIDTH = 4_000_000;
```

---

## 13. Worked example

Scrape returns 4 sources (after merge):

| Identity | Name-based old rank | Probe ttfb | thruput | speedScore | New rank |
|----------|---------------------|------------|---------|------------|----------|
| vixsrc\|Luna | 2 (fast path default) | 3200 ms | 0.8 MB/s | 18 | 4 |
| vidking\|Solstice | 1 | 140 ms | 9 MB/s | 96 | **1** |
| notorrent\|Pulse | 3 | 400 ms | 3 MB/s | 72 | 2 |
| vidlink\|Phoenix | 4 | 180 ms | 7 MB/s | 90 | 3 |

**Outcome:** `streamUrl` = Solstice (measured), not because the label is Solstice. If Solstice is down (403) and Phoenix probes 90, Phoenix wins even though old `providerPriority` demoted VidLink.

---

## 14. Risks & non-goals

**Non-goals v1**

- Client-side (browser) probes — wrong network path vs proxy
- Persisted probe history in SQLite
- Multi-sample EWMA across days
- Replacing circuit breakers (still for provider APIs, not CDN segs)

**Risks**

- +latency on cold full scrape — mitigate: concurrency, 64 KiB cap, cache, skip on fast path  
- CDN rate limits — mitigate: caps + cache + per-host limit  
- Ranking flap mid-play — mitigate: upgrade margin 8 pts + identity sticky until fatal error  

---

## 15. Implementation checklist (for architect/coder)

1. [ ] `curlProbe` with timing write-out, body discard  
2. [ ] `probe.ts`: cache, semaphore, HLS/DASH/MP4 paths, score math  
3. [ ] Wire into full scrape after merge; skip/limit on `fast=1`  
4. [ ] Soft-keep policy preserved  
5. [ ] Additive JSON fields on sources  
6. [ ] Map through `ScraperPlaybackProvider`  
7. [ ] `pickDefaultSource` / `isFasterSource` use `probe.speedScore`  
8. [ ] Remove name-based speed bonuses from rank path (keep UI names)  
9. [ ] `/health` probe section  
10. [ ] Unit tests: m3u parse, score monotonicity, cache TTL, concurrency  
11. [ ] Server smoke: Witcher S1E1 — log probe table; winner has highest speedScore among ok  

---

## 16. Summary

CineHome already has the right **place** (scraper verify + session headers + CDN referer map) and the wrong **signal** (boolean + provider name).  

**Source health probe** upgrades verify to a timed, range-capped first-segment sample, ranks by **TTFB + throughput** measured on the home server (same path as the HLS proxy), caches **5–15 min** (default 10), and limits load with **3 concurrent / 8 per scrape / 12s batch budget / 4 process-wide**.  

False positives are mitigated by matching proxy auth headers and min-byte checks; false negatives by Range-GET preference and all-fail soft-keep; false ranks by 1080p variant pick and upgrade margins.  

**TypeScript interfaces** in §5 are ready to drop into `mini-services/stream-scraper/probe.ts` and additive `PlaybackSource.probe` on the Next playback API.
