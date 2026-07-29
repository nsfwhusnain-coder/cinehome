import { createHash } from "crypto";
import type { HlsSession } from "@/lib/hls-session";
import { onHlsSessionEnd, proxyUrlFor, rememberUpstreamHost } from "@/lib/hls-session";
import {
  firstMediaSegmentUri,
  isPureHlsMediaPlaylist,
  probeSegmentHeight,
  resolvePlaylistUri,
  shouldWrapPureMedia,
  wrapMediaPlaylistAsMaster,
} from "@/lib/hls/segment-height-probe";

/**
 * Segment / manifest cache policy (hybrid global CDN bodies):
 *
 * Segments (T1):
 * - Cache key = `scope|normalize(url)|range` (Range ALWAYS part of key).
 * - scope = "global" when host is a known CDN AND path is segment-like
 *   (.ts/.m4s/.mp4/.aac/.vtt) — body is shareable across sessions.
 * - scope = sessionId for ambiguous hosts (session.allowedHosts / root / non-CDN).
 * - Upstream fetch on miss STILL injects the requesting session's cookies/referer/UA.
 * - Session end only invalidates session-scoped entries; global bodies survive.
 * - Global TTL = SEGMENT_CACHE_TTL_MS (6h); session-scoped TTL capped by remaining session life.
 * - Stale-while-revalidate: expired bodies still served for CACHE_SWR_WINDOW_MS while
 *   a background refresh runs. Negative cache (30s after 3 consecutive fails).
 *
 * Manifests (T2):
 * - Cache RAW (unrewritten) VOD bodies only; re-rewrite proxy URLs for the requesting session.
 * - LIVE (no ENDLIST / dynamic MPD) is never body-cached.
 * - TTL MANIFEST_CACHE_TTL_MS (5m) + same SWR window as segments.
 *
 * Master metadata (Wave 2 / Absolute Cinema quality fix):
 * - X-Stream-Renditions / X-Max-Resolution from EXT-X-STREAM-INF RESOLUTION/BANDWIDTH.
 * - Single-rung masters lacking RESOLUTION get URL-token inject, then Range segment probe.
 * - Pure media playlists (no STREAM-INF) that are the **root** source are wrapped as a
 *   1-rung master with RESOLUTION so hls.js exposes a real height level ("1080p").
 *   Wrap is skipped when `media=1` (child of synthetic master) OR when the upstream URL
 *   looks like a multi-variant child (`rendition=`, `/720/`, `/index-s720p`) — those
 *   must stay pure media or hls.js thrash-reloads the nested synthetic master (R10).
 *
 * Auth params: normalizeUpstreamForCache strips long token/expires/sig names only —
 * never single-letter query params (collapses distinct segments).
 *
 * Eviction: entry count max (2000) AND byte-cap (~512MB) for segment bodies.
 * Prefetch: bounded concurrency; not expanded.
 */

const SEGMENT_CACHE_MAX = 2000;
/** Soft ceiling for global segment bodies (6h). Session-scoped entries are shorter. */
const SEGMENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Byte-weighted LRU cap (~512MB). */
const SEGMENT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Bun's Response.clone() tee retained client/cache branches after seeks and
 * disconnects, growing the Next process until the kernel OOM-killed it.
 * Keep the body-cache implementation dormant until it moves to a streaming
 * disk/edge cache that never duplicates media in the application heap.
 */
export const SEGMENT_BODY_CACHE_ENABLED = false;
/**
 * Speculative prefetch is deliberately disabled. It raced hls.js for the same
 * first segment and, for byte-range playlists whose URI is a whole `.mp4`,
 * fetched the complete feature without a Range header. Interactive hls.js
 * requests still populate the shared segment cache.
 */
const PREFETCH_SEGMENT_COUNT = 0;
/** Upstream fetch timeout for interactive proxy requests. */
const UPSTREAM_TIMEOUT_MS = 25_000;
/** Bytes read before deciding text-manifest vs binary — keeps the sniff itself cheap. */
const MANIFEST_SNIFF_BYTES = 64 * 1024;
/** Hard ceiling for buffering+rewriting a manifest body; anything bigger streams through raw. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** Prefetch fetches run in the background — bound concurrency so they never starve the interactive fetch. */
/**
 * Hard maximum for one buffered cache entry, including an entry that has not
 * reached the LRU yet. The aggregate cache cap cannot protect the process
 * before an unbounded arrayBuffer() completes.
 */
export const SEGMENT_CACHE_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
/** Caps aggregate memory held by cache readers before entries reach the LRU. */
const CACHE_BODY_READ_MAX_CONCURRENCY = 8;
/** VOD master/media playlist raw-body TTL (re-rewritten per session on hit). */
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;
/** Cap in-memory raw manifest entries (text only; small). */
const MANIFEST_CACHE_MAX = 64;
/**
 * After fresh TTL expires, keep serving the body while a background refresh runs.
 * Past this window the entry is hard-evicted (stale + 30min).
 */
const CACHE_SWR_WINDOW_MS = 30 * 60 * 1000;
/** Short-circuit repeated upstream fails (timeout / 5xx / ECONNRESET) for this duration. */
const NEGATIVE_CACHE_TTL_MS = 30_000;
/** Failures required before a URL enters negative cache (reduces flaky single-error storms). */
const NEGATIVE_CACHE_FAIL_THRESHOLD = 3;
/** Cap negative-cache entries (small; keyed by normalized URL). */
const NEGATIVE_CACHE_MAX = 512;
/** Incomplete failure streaks expire instead of living for the process lifetime. */
const NEGATIVE_FAIL_STREAK_TTL_MS = NEGATIVE_CACHE_TTL_MS;
/** Bound one/two-off failures from ever-new segment URLs. */
const NEGATIVE_FAIL_COUNT_MAX = NEGATIVE_CACHE_MAX;
/** Height-inject result cache for masters that lack RESOLUTION (indefinite-ish). */
const RESOLUTION_INJECT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLUTION_INJECT_CACHE_MAX = 256;
/** Range-probe budget for first-segment height sniff (TS/fMP4 header). */
const RESOLUTION_PROBE_TIMEOUT_MS = 800;
const RESOLUTION_PROBE_RANGE_BYTES = 131_071;
/** Default bandwidth advertised on synthetic single-rung masters. */
const SYNTHETIC_MASTER_BANDWIDTH = 5_000_000;
/** Bound JSON size of X-Stream-Renditions. */
const MAX_RENDITION_HEADER_ENTRIES = 16;
/** Browser-facing Cache-Control max-age for VOD rewritten manifests (matches body TTL band). */
const MANIFEST_BROWSER_MAX_AGE_SEC = 300;
/** Hash scope token for cross-session shareable CDN segment/manifest bodies. */
const GLOBAL_CACHE_SCOPE = "global";
/** Reported by getProxyMetrics — hybrid known-CDN segments global; else session. */
const CACHE_KEY_MODE = "hybrid-global-cdn-segments";
/** Only complete successful segment responses may enter the body cache. */
const CACHEABLE_SEGMENT_STATUSES = new Set([200, 206]);

/** Compact STREAM-INF rendition for response headers. */
export interface StreamRenditionHeader {
  height: number;
  width?: number;
  bandwidth?: number;
}

interface CacheEntry {
  body: ArrayBuffer;
  byteLength: number;
  /** Empty string for global shareable bodies; session id when session-scoped. */
  sessionId: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  /** Fresh until this timestamp; SWR may still serve after. */
  expiresAt: number;
}

/** Raw (unrewritten) VOD playlist — rewrite on every hit for the requesting session. */
interface ManifestCacheEntry {
  text: string;
  kind: "m3u8" | "mpd";
  rewriteBase: string;
  /** Empty when globally shareable; session id when session-scoped. */
  sessionId: string;
  /** Fresh until this timestamp; SWR may still serve after. */
  expiresAt: number;
}

interface NegativeCacheEntry {
  status: number;
  message: string;
  expiresAt: number;
}

interface NegativeFailCount {
  count: number;
  expiresAt: number;
}

interface InjectHeightEntry {
  height: number;
  expiresAt: number;
}

/** Fresh = within TTL; stale = expired but within SWR window. */
type CacheLookup<T> = { entry: T; stale: boolean };

export interface ProxyMetrics {
  hits: number;
  misses: number;
  errors: number;
  /** SWR serves (also counted in hits). */
  staleHits: number;
  /** Short-circuited via negative cache. */
  negativeHits: number;
  entries: number;
  bytesCached: number;
  maxEntries: number;
  maxBytes: number;
  hitRate: number;
  /** Cache key strategy identifier for ops dashboards. */
  cacheKeyMode: string;
  /** Raw VOD manifest entries currently held. */
  manifestEntries: number;
  /** Bodies refused because one cache entry exceeded the hard cap. */
  oversizedSkips: number;
  /** Cache fills skipped because the bounded reader pool was saturated. */
  saturatedSkips: number;
  /** Explicitly exposes the production safety policy to system status. */
  speculativePrefetchEnabled: boolean;
  /** False while media bodies are streamed without an in-process tee/cache. */
  segmentBodyCacheEnabled: boolean;
}

const segmentCache = new Map<string, CacheEntry>();
/** LRU order: oldest at index 0. */
const cacheOrder: string[] = [];
/** Reverse index for session-scoped invalidation (global bodies are not listed). */
const sessionKeys = new Map<string, Set<string>>();

const manifestCache = new Map<string, ManifestCacheEntry>();
const manifestOrder: string[] = [];

/** Normalized-URL failures (timeout / 5xx) — avoid retry storms. */
const negativeCache = new Map<string, NegativeCacheEntry>();
/** Consecutive fail counts before negative-cache admission. */
const negativeFailCounts = new Map<string, NegativeFailCount>();
/** Master/media URL → injected height (URL-token or segment probe). */
const injectHeightCache = new Map<string, InjectHeightEntry>();
/** In-flight SWR revalidations (body / manifest cache keys). */
const revalidatingKeys = new Set<string>();

let cacheBytes = 0;

const metrics = {
  hits: 0,
  misses: 0,
  errors: 0,
  staleHits: 0,
  negativeHits: 0,
  oversizedSkips: 0,
  saturatedSkips: 0,
};

let cacheBodyReadsInFlight = 0;

/**
 * Strip ephemeral auth query params so the same segment body reuses cache
 * across token/expiry rotations (hit rate was ~2.5% without this).
 *
 * Only long, unambiguously-named auth/token params are dropped. Short
 * single/double-letter params (`t`, `s`, `e`, `h`, `ts`, ...) are deliberately
 * NOT dropped — different CDNs reuse those same letters for positional /
 * content-differentiating values (segment index, start byte, track id), so
 * stripping them collapsed genuinely different segments onto one cache key
 * (wrong bytes served, freezes, AV desync).
 */
function normalizeUpstreamForCache(url: string): string {
  try {
    const u = new URL(url);
    const drop = new Set([
      "token",
      "expires",
      "expire",
      "exp",
      "sig",
      "signature",
      "key",
      "hash",
      "auth",
      "authorization",
      "jwt",
      "access_token",
      "timestamp",
      "nonce",
    ]);
    const clean = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (drop.has(k.toLowerCase())) continue;
      clean.set(k, v);
    }
    const q = clean.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
  } catch {
    return url;
  }
}

/**
 * True when a segment body is safe to share across sessions:
 * known CDN host + media segment extension, not a key/playlist.
 * Ambiguous hosts stay session-scoped (auth-bound roots / discovered hosts).
 */
function isGlobalSegmentCacheable(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!isKnownCdnHost(host)) return false;
    if (isKeyUrl(url)) return false;
    const lower = url.toLowerCase();
    if (lower.includes(".m3u8") || lower.includes(".mpd") || lower.includes("playlist")) {
      return false;
    }
    return isSegmentUrl(url);
  } catch {
    return false;
  }
}

function isGlobalManifestCacheable(url: string): boolean {
  try {
    return isKnownCdnHost(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Resolve body-cache scope: global CDN segments vs session-bound ambiguous URLs. */
type BodyCacheKind = "segment" | "manifest";

function resolveBodyCacheScope(
  session: HlsSession,
  url: string,
  kind: BodyCacheKind
): { keyScope: string; sessionTag: string; global: boolean } {
  const global =
    kind === "segment" ? isGlobalSegmentCacheable(url) : isGlobalManifestCacheable(url);
  if (global) {
    return { keyScope: GLOBAL_CACHE_SCOPE, sessionTag: "", global: true };
  }
  return { keyScope: session.id, sessionTag: session.id, global: false };
}

function bodyCacheKey(keyScope: string, url: string, range: string | null): string {
  const normalized = normalizeUpstreamForCache(url);
  return createHash("sha256")
    .update(`${keyScope}|${normalized}|${range ?? ""}`)
    .digest("hex");
}

function manifestBodyCacheKey(keyScope: string, url: string): string {
  const normalized = normalizeUpstreamForCache(url);
  return createHash("sha256").update(`m|${keyScope}|${normalized}`).digest("hex");
}

function segmentEntryTtlMs(session: HlsSession, global: boolean): number {
  if (global) return SEGMENT_CACHE_TTL_MS;
  const remaining = session.expiresAt - Date.now();
  return Math.max(0, Math.min(SEGMENT_CACHE_TTL_MS, remaining));
}

/** Reject truncated/poison bodies before they enter the segment cache. */
function isIntactCacheableBody(
  status: number,
  body: ArrayBuffer,
  headers: Record<string, string>
): boolean {
  if (!CACHEABLE_SEGMENT_STATUSES.has(status)) return false;
  if (body.byteLength === 0) return false;
  const cl = headers["content-length"];
  if (cl != null && cl !== "") {
    const expected = Number(cl);
    if (Number.isFinite(expected) && expected > 0 && expected !== body.byteLength) {
      return false;
    }
  }
  return true;
}

function isVodM3u8(text: string): boolean {
  if (text.includes("#EXT-X-ENDLIST")) return true;
  if (/#EXT-X-PLAYLIST-TYPE\s*:\s*VOD/i.test(text)) return true;
  return false;
}

/** Static MPD → cacheable; clearly dynamic live → not; uncertain → short TTL allowed. */
function isCacheableMpd(text: string): boolean {
  if (/type\s*=\s*["']dynamic["']/i.test(text)) return false;
  if (/minimumUpdatePeriod\s*=/i.test(text) && !/type\s*=\s*["']static["']/i.test(text)) {
    return false;
  }
  return true;
}

function removeFromOrder(key: string): void {
  const idx = cacheOrder.indexOf(key);
  if (idx >= 0) cacheOrder.splice(idx, 1);
}

function untrackSessionKey(sessionId: string, key: string): void {
  if (!sessionId) return;
  const keys = sessionKeys.get(sessionId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) sessionKeys.delete(sessionId);
}

function deleteCacheEntry(key: string): void {
  const entry = segmentCache.get(key);
  if (!entry) return;
  cacheBytes = Math.max(0, cacheBytes - entry.byteLength);
  segmentCache.delete(key);
  removeFromOrder(key);
  untrackSessionKey(entry.sessionId, key);
}

/**
 * Lookup segment body. Fresh within TTL; stale within SWR window (caller revalidates).
 * Hard-evicts only after SWR window ends.
 */
function getCachedSegment(key: string): CacheLookup<CacheEntry> | null {
  const entry = segmentCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now <= entry.expiresAt) {
    removeFromOrder(key);
    cacheOrder.push(key);
    return { entry, stale: false };
  }
  if (now <= entry.expiresAt + CACHE_SWR_WINDOW_MS) {
    removeFromOrder(key);
    cacheOrder.push(key);
    return { entry, stale: true };
  }
  deleteCacheEntry(key);
  return null;
}

function evictIfNeeded(): void {
  while (
    cacheOrder.length > 0 &&
    (cacheOrder.length > SEGMENT_CACHE_MAX || cacheBytes > SEGMENT_CACHE_MAX_BYTES)
  ) {
    const oldest = cacheOrder[0];
    if (!oldest) break;
    deleteCacheEntry(oldest);
  }
}

function setCachedSegment(key: string, entry: CacheEntry): void {
  if (segmentCache.has(key)) {
    deleteCacheEntry(key);
  }
  segmentCache.set(key, entry);
  cacheOrder.push(key);
  cacheBytes += entry.byteLength;

  // Global bodies are not session-tracked — they survive session end.
  if (entry.sessionId) {
    let keys = sessionKeys.get(entry.sessionId);
    if (!keys) {
      keys = new Set();
      sessionKeys.set(entry.sessionId, keys);
    }
    keys.add(key);
  }

  evictIfNeeded();
}

function removeManifestFromOrder(key: string): void {
  const idx = manifestOrder.indexOf(key);
  if (idx >= 0) manifestOrder.splice(idx, 1);
}

function deleteManifestEntry(key: string): void {
  if (!manifestCache.has(key)) return;
  manifestCache.delete(key);
  removeManifestFromOrder(key);
}

/**
 * Lookup raw VOD manifest. Fresh within TTL; stale within SWR window.
 */
function getCachedManifest(key: string): CacheLookup<ManifestCacheEntry> | null {
  const entry = manifestCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now <= entry.expiresAt) {
    removeManifestFromOrder(key);
    manifestOrder.push(key);
    return { entry, stale: false };
  }
  if (now <= entry.expiresAt + CACHE_SWR_WINDOW_MS) {
    removeManifestFromOrder(key);
    manifestOrder.push(key);
    return { entry, stale: true };
  }
  deleteManifestEntry(key);
  return null;
}

function negativeCacheKey(
  session: HlsSession,
  url: string,
  range: string | null,
  kind: BodyCacheKind
): string {
  // Match the positive body cache's trust boundary: known CDN media may be
  // global, while auth-bound roots and ambiguous hosts remain isolated to the
  // HLS session that supplied their cookies/referer.
  const scope = resolveBodyCacheScope(session, url, kind).keyScope;
  return createHash("sha256")
    .update(`neg|${scope}|${normalizeUpstreamForCache(url)}|${range ?? ""}`)
    .digest("hex");
}

function getNegativeCache(
  session: HlsSession,
  url: string,
  range: string | null,
  kind: BodyCacheKind
): NegativeCacheEntry | null {
  const key = negativeCacheKey(session, url, range, kind);
  const entry = negativeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    negativeCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Record an upstream failure. Only admits to negative cache after
 * NEGATIVE_CACHE_FAIL_THRESHOLD consecutive fails for the same key.
 * Returns true when the negative entry was written.
 */
function setNegativeCache(
  session: HlsSession,
  url: string,
  range: string | null,
  kind: BodyCacheKind,
  status: number,
  message: string
): boolean {
  const key = negativeCacheKey(session, url, range, kind);
  const now = Date.now();
  for (const [candidate, entry] of negativeFailCounts) {
    if (entry.expiresAt <= now) negativeFailCounts.delete(candidate);
  }
  const previous = negativeFailCounts.get(key);
  const fails =
    (previous && previous.expiresAt > now ? previous.count : 0) + 1;
  // Refresh insertion order so the cap evicts the least-recent streak.
  negativeFailCounts.delete(key);
  negativeFailCounts.set(key, {
    count: fails,
    expiresAt: now + NEGATIVE_FAIL_STREAK_TTL_MS,
  });
  if (fails < NEGATIVE_CACHE_FAIL_THRESHOLD) {
    while (negativeFailCounts.size > NEGATIVE_FAIL_COUNT_MAX) {
      const oldest = negativeFailCounts.keys().next().value;
      if (oldest === undefined) break;
      negativeFailCounts.delete(oldest);
    }
    return false;
  }
  negativeCache.set(key, {
    status,
    message,
    expiresAt: now + NEGATIVE_CACHE_TTL_MS,
  });
  negativeFailCounts.delete(key);
  while (negativeCache.size > NEGATIVE_CACHE_MAX) {
    const oldest = negativeCache.keys().next().value;
    if (oldest === undefined) break;
    negativeCache.delete(oldest);
  }
  return true;
}

/** Clear fail streak on any successful upstream body (segment or manifest). */
function clearNegativeFailStreak(
  session: HlsSession,
  url: string,
  range: string | null,
  kind: BodyCacheKind
): void {
  negativeFailCounts.delete(negativeCacheKey(session, url, range, kind));
}

function injectHeightCacheKey(url: string): string {
  return createHash("sha256").update(`inj|${normalizeUpstreamForCache(url)}`).digest("hex");
}

function getCachedInjectHeight(url: string): number {
  const key = injectHeightCacheKey(url);
  const entry = injectHeightCache.get(key);
  if (!entry) return 0;
  if (Date.now() > entry.expiresAt) {
    injectHeightCache.delete(key);
    return 0;
  }
  return entry.height;
}

function setCachedInjectHeight(url: string, height: number): void {
  if (height <= 0) return;
  const key = injectHeightCacheKey(url);
  injectHeightCache.set(key, {
    height,
    expiresAt: Date.now() + RESOLUTION_INJECT_CACHE_TTL_MS,
  });
  while (injectHeightCache.size > RESOLUTION_INJECT_CACHE_MAX) {
    const oldest = injectHeightCache.keys().next().value;
    if (oldest === undefined) break;
    injectHeightCache.delete(oldest);
  }
}

function setCachedManifest(key: string, entry: ManifestCacheEntry): void {
  if (manifestCache.has(key)) {
    deleteManifestEntry(key);
  }
  manifestCache.set(key, entry);
  manifestOrder.push(key);
  while (manifestOrder.length > MANIFEST_CACHE_MAX) {
    const oldest = manifestOrder[0];
    if (!oldest) break;
    deleteManifestEntry(oldest);
  }
}

/**
 * Drop session-scoped segment + manifest entries for this session.
 * Global CDN bodies are retained for cross-session reuse.
 */
export function invalidateSessionCache(sessionId: string): void {
  const keys = sessionKeys.get(sessionId);
  if (keys) {
    for (const key of [...keys]) {
      deleteCacheEntry(key);
    }
    sessionKeys.delete(sessionId);
  }
  for (const [key, entry] of [...manifestCache.entries()]) {
    if (entry.sessionId === sessionId) {
      deleteManifestEntry(key);
    }
  }
}

onHlsSessionEnd(invalidateSessionCache);

export function getProxyMetrics(): ProxyMetrics {
  const total = metrics.hits + metrics.misses;
  return {
    hits: metrics.hits,
    misses: metrics.misses,
    errors: metrics.errors,
    staleHits: metrics.staleHits,
    negativeHits: metrics.negativeHits,
    entries: segmentCache.size,
    bytesCached: cacheBytes,
    maxEntries: SEGMENT_CACHE_MAX,
    maxBytes: SEGMENT_CACHE_MAX_BYTES,
    // SWR serves count as hits (staleHits is a breakdown); negativeHits are separate.
    hitRate: total === 0 ? 0 : metrics.hits / total,
    cacheKeyMode: CACHE_KEY_MODE,
    manifestEntries: manifestCache.size,
    oversizedSkips: metrics.oversizedSkips,
    saturatedSkips: metrics.saturatedSkips,
    speculativePrefetchEnabled: PREFETCH_SEGMENT_COUNT > 0,
    segmentBodyCacheEnabled: SEGMENT_BODY_CACHE_ENABLED,
  };
}

function isSegmentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".ts") ||
    lower.includes(".m4s") ||
    lower.includes(".mp4") ||
    lower.includes(".aac") ||
    lower.includes(".vtt")
  );
}

/**
 * Some download CDNs label browser-playable media as
 * `application/force-download` or generic octet-stream. That works when the
 * direct URL still ends in `.mp4`, but not after it is hidden behind our
 * extensionless `/api/hls/...` route: Chromium then refuses to attach a media
 * decoder. Preserve specific upstream media MIME types and infer only from an
 * unambiguous file extension for generic download responses.
 */
export function mediaContentTypeForProxy(
  upstream: string,
  upstreamContentType: string
): string {
  const baseType = upstreamContentType.split(";", 1)[0]!.trim().toLowerCase();
  const generic =
    baseType === "" ||
    baseType === "application/octet-stream" ||
    baseType === "application/force-download" ||
    baseType === "application/download" ||
    baseType === "binary/octet-stream";
  if (!generic) return upstreamContentType;

  let pathname = "";
  try {
    pathname = new URL(upstream).pathname.toLowerCase();
  } catch {
    pathname = upstream.split(/[?#]/, 1)[0]!.toLowerCase();
  }
  if (pathname.endsWith(".mp4") || pathname.endsWith(".m4v")) return "video/mp4";
  if (pathname.endsWith(".m4s")) return "video/iso.segment";
  if (pathname.endsWith(".ts")) return "video/mp2t";
  if (pathname.endsWith(".aac")) return "audio/aac";
  if (pathname.endsWith(".vtt")) return "text/vtt";
  return upstreamContentType || "application/octet-stream";
}

/** AES-128 key / binary auth blobs — NEVER text-sniff or UTF-8 re-encode. */
function isKeyUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("enc.key") ||
    lower.includes("/key") ||
    lower.includes(".key") ||
    lower.includes("key.bin") ||
    lower.includes("keys/") ||
    /[?&]key=/i.test(lower)
  );
}

/**
 * Warm the first N media segments from an (unrewritten) m3u8 media playlist.
 * Uses absolute upstream URLs so cache keys match live segment proxy requests.
 * Fire-and-forget; never blocks the playlist response.
 */
function prefetchSegments(session: HlsSession, manifest: string, baseUrl: string): void {
  if (PREFETCH_SEGMENT_COUNT <= 0) return;
  // Session must still be alive for upstream auth headers on miss.
  if (session.expiresAt <= Date.now()) return;

  const urls: string[] = [];
  for (const line of manifest.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      urls.push(resolveUrl(trimmed, baseUrl));
    } catch {
      /* skip */
    }
  }

  const misses: string[] = [];
  const seen = new Set<string>();
  let queued = 0;
  for (const url of urls) {
    if (queued >= PREFETCH_SEGMENT_COUNT) break;
    if (!isSegmentUrl(url)) continue;
    if (!isAllowedUpstreamUrl(url, session)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const scope = resolveBodyCacheScope(session, url, "segment");
    // Fresh or SWR-stale counts as warm — no need to re-prefetch.
    if (getCachedSegment(bodyCacheKey(scope.keyScope, url, null))) {
      queued += 1;
      continue;
    }

    queued += 1;
    misses.push(url);
  }

  if (misses.length === 0) return;

  // Bounded worker pool — never fire all misses at once (would starve the
  // interactive segment fetch competing for the same upstream/connection budget).
  let cursor = 0;
  const warmOne = async (): Promise<void> => {
    while (cursor < misses.length) {
      const url = misses[cursor++]!;
      const scope = resolveBodyCacheScope(session, url, "segment");
      const key = bodyCacheKey(scope.keyScope, url, null);
      try {
        const res = await fetchUpstreamSafely(
          url,
          buildUpstreamHeaders(session, url, null),
          UPSTREAM_TIMEOUT_MS
        );
        if (!res.ok) continue;
        const body = await readResponseBodyForCache(res);
        if (!body) continue;
        const passthrough = pickPassthroughHeaders(res);
        if (!isIntactCacheableBody(res.status, body, passthrough)) continue;
        const prefetchTtl = segmentEntryTtlMs(session, scope.global);
        if (prefetchTtl <= 0) continue;
        setCachedSegment(key, {
          body,
          byteLength: body.byteLength,
          sessionId: scope.sessionTag,
          status: res.status,
          contentType: res.headers.get("content-type") || "application/octet-stream",
          headers: passthrough,
          expiresAt: Date.now() + prefetchTtl,
        });
      } catch {
        /* best-effort background warm — never throw; never poison cache */
      }
    }
  };

  const workerCount = Math.min(1, misses.length);
  for (let i = 0; i < workerCount; i++) void warmOne();
}

function pickPassthroughHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-range", "content-length", "accept-ranges"] as const) {
    const value = res.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function segmentOutHeaders(upstreamRes: Response, contentType: string, isSegment: boolean): Headers {
  const outHeaders = new Headers();
  // private: segment URLs are session/auth-bound (embed a per-user HLS session id) —
  // a shared/public cache (CDN, corporate proxy) must never store these.
  outHeaders.set("Cache-Control", isSegment ? "private, max-age=3600" : "no-store");
  outHeaders.set("Content-Type", contentType || "application/octet-stream");
  const contentRange = upstreamRes.headers.get("content-range");
  const contentLength = upstreamRes.headers.get("content-length");
  const acceptRanges = upstreamRes.headers.get("accept-ranges");
  if (contentRange) outHeaders.set("Content-Range", contentRange);
  if (contentLength) outHeaders.set("Content-Length", contentLength);
  if (acceptRanges) outHeaders.set("Accept-Ranges", acceptRanges);
  return outHeaders;
}

/** Cache segment body in background; does not throw or poison on partial/error. */
function cacheSegmentAsync(
  session: HlsSession,
  upstream: string,
  rangeHeader: string | null,
  status: number,
  contentType: string,
  headers: Record<string, string>,
  bodyPromise: Promise<ArrayBuffer | null>
): void {
  if (!CACHEABLE_SEGMENT_STATUSES.has(status)) return;
  const scope = resolveBodyCacheScope(session, upstream, "segment");
  const ttl = segmentEntryTtlMs(session, scope.global);
  if (ttl <= 0) return;
  const segKey = bodyCacheKey(scope.keyScope, upstream, rangeHeader);
  void bodyPromise
    .then((body) => {
      if (!body) return;
      // ECONNRESET / truncated body: reject before insert (do not poison).
      if (!isIntactCacheableBody(status, body, headers)) return;
      const remaining = segmentEntryTtlMs(session, scope.global);
      if (remaining <= 0) return;
      setCachedSegment(segKey, {
        body,
        byteLength: body.byteLength,
        sessionId: scope.sessionTag,
        status,
        contentType: contentType || "application/octet-stream",
        headers,
        expiresAt: Date.now() + remaining,
      });
    })
    .catch(() => {
      /* aborted / reset — leave cache untouched */
    });
}

function maybeCacheRawManifest(
  session: HlsSession,
  upstream: string,
  text: string,
  kind: "m3u8" | "mpd",
  rewriteBase: string
): void {
  if (kind === "m3u8" && !isVodM3u8(text)) return;
  if (kind === "mpd" && !isCacheableMpd(text)) return;
  const scope = resolveBodyCacheScope(session, upstream, "manifest");
  const key = manifestBodyCacheKey(scope.keyScope, upstream);
  setCachedManifest(key, {
    text,
    kind,
    rewriteBase,
    sessionId: scope.sessionTag,
    expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
  });
}

/**
 * Unambiguous URL path/name token → height. Never invents beyond exact tokens
 * (/1080/, 1080p, 4k, …). Mirrors scraper quality-probe convention.
 */
export function inferHeightFromUrlToken(text: string): number {
  const lower = text.toLowerCase();
  if (/\b4k\b/.test(lower)) return 2160;
  const indexedToken = lower.match(
    /(?:^|[\/_.-])index-s(2160|1440|1080|720|480|360|320)p(?:[\/_.?&-]|$)/
  );
  if (indexedToken) return Number(indexedToken[1]);
  const pathToken = lower.match(/[\/_-](2160|1440|1080|720|480|360|320)p?(?:[\/_.?&-]|$)/);
  if (pathToken) return Number(pathToken[1]);
  const pToken = lower.match(/\b(2160|1440|1080|720|480|360|320)p\b/);
  if (pToken) return Number(pToken[1]);
  return 0;
}

/** Derive 16:9 width from known height (standard ladder). */
function widthForHeight(height: number): number {
  return Math.round((height * 16) / 9);
}

function resolutionAttrForHeight(height: number): string {
  return `RESOLUTION=${widthForHeight(height)}x${height}`;
}

/**
 * Parse EXT-X-STREAM-INF for RESOLUTION / BANDWIDTH. Does not invent heights.
 */
export function parseStreamInfRenditions(m3u8: string): StreamRenditionHeader[] {
  const out: StreamRenditionHeader[] = [];
  for (const raw of m3u8.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const res = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    if (!res) continue;
    const width = Number(res[1]);
    const height = Number(res[2]);
    if (!Number.isFinite(height) || height <= 0) continue;
    const bw = line.match(/BANDWIDTH=(\d+)/i);
    const entry: StreamRenditionHeader = { height };
    if (Number.isFinite(width) && width > 0) entry.width = width;
    if (bw) {
      const bandwidth = Number(bw[1]);
      if (Number.isFinite(bandwidth) && bandwidth > 0) entry.bandwidth = bandwidth;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Set X-Stream-Renditions / X-Max-Resolution when STREAM-INF has RESOLUTION.
 * Omits headers when no RESOLUTION tags (do not invent).
 */
function applyResolutionHeaders(headers: Headers, m3u8Text: string): void {
  const renditions = parseStreamInfRenditions(m3u8Text);
  if (renditions.length === 0) return;
  const bounded = renditions.slice(0, MAX_RENDITION_HEADER_ENTRIES);
  const maxHeight = Math.max(...bounded.map((r) => r.height));
  headers.set("X-Stream-Renditions", JSON.stringify(bounded));
  headers.set("X-Max-Resolution", String(maxHeight));
  headers.set("Access-Control-Expose-Headers", "X-Stream-Renditions, X-Max-Resolution");
}

/**
 * Inject RESOLUTION= into STREAM-INF lines that lack it when the master has
 * zero RESOLUTION tags (single-rung / bare masters). Does not modify masters
 * that already declare RESOLUTION on any STREAM-INF.
 *
 * Height source (cheap → network):
 * 1. Per-URI URL token (/1080/, 1080p, …)
 * 2. Master URL token
 * 3. Long-lived inject-height cache for this master URL
 * 4. Range probe of first media segment (TS/fMP4) — only when still unknown
 *
 * On probe failure the original STREAM-INF lines are left unchanged (hard requirement).
 */
function injectMissingResolutionsSync(text: string, masterUrl: string, forcedHeight = 0): string {
  if (!text.includes("#EXT-X-STREAM-INF")) return text;

  const lines = text.split("\n");
  let hasStreamInf = false;
  let hasAnyResolution = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-STREAM-INF")) continue;
    hasStreamInf = true;
    if (/RESOLUTION=/i.test(trimmed)) hasAnyResolution = true;
  }
  if (!hasStreamInf || hasAnyResolution) return text;

  const masterCachedHeight = getCachedInjectHeight(masterUrl);
  const masterUrlHeight = inferHeightFromUrlToken(masterUrl);
  const result: string[] = [];
  let injectedHeight = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-STREAM-INF") || /RESOLUTION=/i.test(trimmed)) {
      result.push(line);
      continue;
    }

    let uriLine = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (!next || next.startsWith("#")) continue;
      uriLine = next;
      break;
    }

    const height =
      inferHeightFromUrlToken(uriLine) ||
      masterUrlHeight ||
      masterCachedHeight ||
      forcedHeight ||
      0;
    if (height <= 0) {
      result.push(line);
      continue;
    }
    injectedHeight = height;
    result.push(`${trimmed},${resolutionAttrForHeight(height)}`);
  }

  if (injectedHeight > 0) {
    setCachedInjectHeight(masterUrl, injectedHeight);
  }
  return result.join("\n");
}

/** Proxy URL for a media-playlist child of a synthetic master (`media=1` skips re-wrap). */
function proxyUrlForMediaPlaylist(session: HlsSession, upstream: string): string {
  const base = proxyUrlFor(session, upstream);
  if (base.includes("media=1")) return base;
  return base.includes("?") ? `${base}&media=1` : `${base}?media=1`;
}

/**
 * Resolve height for annotation: tokens → cache → first-segment Range probe.
 * Returns 0 when unknown (never invent).
 */
async function resolveHeightForPlaylist(
  session: HlsSession,
  playlistUrl: string,
  playlistText: string,
  rewriteBase: string
): Promise<number> {
  const token =
    inferHeightFromUrlToken(playlistUrl) ||
    inferHeightFromUrlToken(playlistText.slice(0, 2_000));
  if (token > 0) return token;

  const cached = getCachedInjectHeight(playlistUrl);
  if (cached > 0) return cached;

  // First URI in master (variant) or media playlist (segment)
  let firstUri: string | null = null;
  if (playlistText.includes("#EXT-X-STREAM-INF")) {
    const lines = playlistText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.trim().startsWith("#EXT-X-STREAM-INF")) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (!next || next.startsWith("#")) continue;
        firstUri = next;
        break;
      }
      break;
    }
  } else {
    firstUri = firstMediaSegmentUri(playlistText);
  }
  if (!firstUri) return 0;

  const absolute = resolvePlaylistUri(rewriteBase || playlistUrl, firstUri);
  // If first URI is another playlist, probe won't help much — try segment-like only.
  const lower = absolute.toLowerCase();
  const looksSegment =
    lower.includes(".ts") ||
    lower.includes(".m4s") ||
    lower.includes(".mp4") ||
    lower.includes("/seg") ||
    lower.includes("segment") ||
    !lower.includes(".m3u8");

  if (!looksSegment) {
    // Variant URI is a media playlist — token on that path only
    return inferHeightFromUrlToken(absolute);
  }

  rememberUpstreamHost(session, absolute);
  const headers = buildUpstreamHeaders(session, absolute, `bytes=0-${RESOLUTION_PROBE_RANGE_BYTES}`);
  const height = await probeSegmentHeight(absolute, {
    headers,
    timeoutMs: RESOLUTION_PROBE_TIMEOUT_MS,
    rangeEnd: RESOLUTION_PROBE_RANGE_BYTES,
  });
  if (height > 0) setCachedInjectHeight(playlistUrl, height);
  return height;
}

/**
 * Prepare m3u8 text for client delivery:
 * - masters: inject missing RESOLUTION (token/cache/probe)
 * - pure media **roots** only: wrap as 1-rung master with RESOLUTION for quality menu
 * - multi-variant children / media=1: pass through (URI rewrite later)
 * - on any probe failure: return original text (silent fallback)
 */
async function prepareM3u8ForClient(
  session: HlsSession,
  upstream: string,
  rawText: string,
  rewriteBase: string,
  options: { skipMediaWrap?: boolean }
): Promise<string> {
  try {
    if (isPureHlsMediaPlaylist(rawText)) {
      // R10: never wrap variant children or synthetic-master media=1 fetches.
      if (!shouldWrapPureMedia(upstream, options.skipMediaWrap === true)) {
        return rawText;
      }
      const height = await resolveHeightForPlaylist(session, upstream, rawText, rewriteBase);
      if (height <= 0) {
        // Unknown height — do not invent a wrap; original media playlist.
        return rawText;
      }
      setCachedInjectHeight(upstream, height);
      const mediaChild = proxyUrlForMediaPlaylist(session, upstream);
      return wrapMediaPlaylistAsMaster(mediaChild, height, SYNTHETIC_MASTER_BANDWIDTH);
    }

    // Master path: try cheap inject first, then probe if still no RESOLUTION.
    let prepared = injectMissingResolutionsSync(rawText, upstream, 0);
    if (!parseStreamInfRenditions(prepared).length && rawText.includes("#EXT-X-STREAM-INF")) {
      const height = await resolveHeightForPlaylist(session, upstream, rawText, rewriteBase);
      if (height > 0) {
        prepared = injectMissingResolutionsSync(rawText, upstream, height);
      }
    }
    return prepared;
  } catch {
    // Hard requirement: never serve a broken rewrite — fall back to original.
    return rawText;
  }
}

async function buildM3u8Response(
  session: HlsSession,
  upstream: string,
  rawText: string,
  rewriteBase: string,
  options: { skipMediaWrap?: boolean } = {}
): Promise<Response> {
  // Inject / wrap before rewrite so X-Stream-Renditions sees RESOLUTION; rewrite only touches URIs.
  const prepared = await prepareM3u8ForClient(
    session,
    upstream,
    rawText,
    rewriteBase,
    options
  );
  // When we wrap as synthetic master, URIs are already proxy URLs — only rewrite
  // segment/key lines inside true media playlists / original masters.
  const didSyntheticWrap =
    isPureHlsMediaPlaylist(rawText) &&
    prepared !== rawText &&
    shouldWrapPureMedia(upstream, options.skipMediaWrap === true);
  const rewritten = didSyntheticWrap
    ? prepared // synthetic master already has proxy media URI
    : rewriteM3u8(prepared, session, rewriteBase);
  prefetchSegments(session, rawText, rewriteBase);
  const isLive = !isVodM3u8(rawText);
  const headers = new Headers();
  headers.set("Content-Type", "application/vnd.apple.mpegurl");
  headers.set(
    "Cache-Control",
    isLive ? "no-store" : `private, max-age=${MANIFEST_BROWSER_MAX_AGE_SEC}`
  );
  applyResolutionHeaders(headers, prepared);
  // For pure-media wrap, headers come from the synthetic master text.
  if (isPureHlsMediaPlaylist(rawText) && prepared !== rawText) {
    applyResolutionHeaders(headers, prepared);
  }
  return new Response(rewritten, { status: 200, headers });
}

function buildMpdResponse(text: string, session: HlsSession, rewriteBase: string): Response {
  const rewritten = rewriteMpd(text, session, rewriteBase);
  const mpdCacheable = isCacheableMpd(text);
  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/dash+xml",
      "Cache-Control": mpdCacheable
        ? `private, max-age=${MANIFEST_BROWSER_MAX_AGE_SEC}`
        : "no-store",
    },
  });
}

/**
 * Background re-fetch of a stale VOD raw manifest. Does not throw to callers.
 */
function revalidateManifestInBackground(
  session: HlsSession,
  upstream: string,
  cacheKey: string
): void {
  if (revalidatingKeys.has(cacheKey)) return;
  if (session.expiresAt <= Date.now()) return;
  revalidatingKeys.add(cacheKey);
  void (async () => {
    try {
      const res = await fetchUpstreamSafely(
        upstream,
        buildUpstreamHeaders(session, upstream, null),
        UPSTREAM_TIMEOUT_MS
      );
      if (!res.ok) {
        if (res.status >= 500) {
          setNegativeCache(
            session,
            upstream,
            null,
            "manifest",
            res.status,
            `Upstream ${res.status}`
          );
        }
        return;
      }
      const text = await res.text();
      const rewriteBase = res.url || upstream;
      if (isM3u8Content(res.headers.get("content-type") || "", upstream, text)) {
        maybeCacheRawManifest(session, upstream, text, "m3u8", rewriteBase);
      } else if (isMpdContent(res.headers.get("content-type") || "", upstream, text)) {
        maybeCacheRawManifest(session, upstream, text, "mpd", rewriteBase);
      }
    } catch {
      setNegativeCache(
        session,
        upstream,
        null,
        "manifest",
        502,
        "Upstream fetch failed"
      );
    } finally {
      revalidatingKeys.delete(cacheKey);
    }
  })();
}

/**
 * Background re-fetch of a stale segment body.
 */
function revalidateSegmentInBackground(
  session: HlsSession,
  upstream: string,
  rangeHeader: string | null,
  cacheKey: string
): void {
  if (revalidatingKeys.has(cacheKey)) return;
  if (session.expiresAt <= Date.now()) return;
  revalidatingKeys.add(cacheKey);
  void (async () => {
    try {
      const res = await fetchUpstreamSafely(
        upstream,
        buildUpstreamHeaders(session, upstream, rangeHeader),
        UPSTREAM_TIMEOUT_MS
      );
      if (!res.ok) {
        if (res.status >= 500) {
          setNegativeCache(
            session,
            upstream,
            rangeHeader,
            "segment",
            res.status,
            `Upstream ${res.status}`
          );
        }
        return;
      }
      const body = await readResponseBodyForCache(res);
      if (!body) return;
      const passthrough = pickPassthroughHeaders(res);
      if (!isIntactCacheableBody(res.status, body, passthrough)) return;
      const scope = resolveBodyCacheScope(session, upstream, "segment");
      const ttl = segmentEntryTtlMs(session, scope.global);
      if (ttl <= 0) return;
      setCachedSegment(cacheKey, {
        body,
        byteLength: body.byteLength,
        sessionId: scope.sessionTag,
        status: res.status,
        contentType: res.headers.get("content-type") || "application/octet-stream",
        headers: passthrough,
        expiresAt: Date.now() + ttl,
      });
    } catch {
      setNegativeCache(
        session,
        upstream,
        rangeHeader,
        "segment",
        502,
        "Upstream fetch failed"
      );
    } finally {
      revalidatingKeys.delete(cacheKey);
    }
  })();
}

async function tryServeCachedManifest(
  session: HlsSession,
  upstream: string,
  options: FetchProxiedOptions = {}
): Promise<Response | null> {
  const scope = resolveBodyCacheScope(session, upstream, "manifest");
  const key = manifestBodyCacheKey(scope.keyScope, upstream);
  // Also try global when session-scoped miss (URL may have become known-CDN later).
  let lookup = getCachedManifest(key);
  let usedKey = key;
  if (!lookup && !scope.global) {
    const globalKey = manifestBodyCacheKey(GLOBAL_CACHE_SCOPE, upstream);
    lookup = getCachedManifest(globalKey);
    if (lookup) usedKey = globalKey;
  }
  if (!lookup) return null;

  metrics.hits += 1;
  if (lookup.stale) {
    metrics.staleHits += 1;
    revalidateManifestInBackground(session, upstream, usedKey);
  }

  const entry = lookup.entry;
  if (entry.kind === "mpd") {
    return buildMpdResponse(entry.text, session, entry.rewriteBase);
  }
  return buildM3u8Response(session, upstream, entry.text, entry.rewriteBase, {
    skipMediaWrap: options.skipMediaWrap === true,
  });
}

function buildUpstreamHeaders(
  session: HlsSession,
  upstream: string,
  rangeHeader: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": session.userAgent,
    Referer: refererFor(session, upstream),
    Origin: originFor(session, upstream),
    ...session.extraHeaders,
  };
  if (session.cookies) headers.Cookie = session.cookies;
  if (rangeHeader) headers.Range = rangeHeader;
  return headers;
}

const REFERER_OVERRIDES: Record<string, string> = {
  "storm.vodvidl.site": "https://vidlink.pro/",
  "stormvv.vodvidl.site": "https://vidlink.pro/",
  "sacdn.hakunaymatata.com": "https://vidlink.pro/",
  "bcdn.hakunaymatata.com": "https://vidlink.pro/",
  "cacdn.hakunaymatata.com": "https://vidlink.pro/",
  "moon.ironbubble.site": "https://www.vidking.net/",
  "infantinostreet.site": "https://www.vidking.net/",
  "ironbubble.site": "https://www.vidking.net/",
  "vix-content.net": "https://vixsrc.to/",
};

function refererFor(session: HlsSession, target: string): string {
  try {
    const host = new URL(target).hostname.toLowerCase();
    if (REFERER_OVERRIDES[host]) return REFERER_OVERRIDES[host]!;
    // Suffix match — exact host map misses sc-u12-01.vix-content.net
    if (host.endsWith(".vix-content.net") || host === "vix-content.net") {
      return "https://vixsrc.to/";
    }
    if (
      host.endsWith(".ironbubble.site") ||
      host.endsWith(".frygarden.site") ||
      host.endsWith(".ironwallnet.net") ||
      host === "ironwallnet.net"
    ) {
      return "https://www.vidking.net/";
    }
    if (host.endsWith(".vodvidl.site") || host.endsWith(".hakunaymatata.com")) {
      return "https://vidlink.pro/";
    }
    return session.referer;
  } catch {
    return session.referer;
  }
}

function originFor(session: HlsSession, target: string): string {
  const referer = refererFor(session, target);
  try {
    return new URL(referer).origin;
  } catch {
    return session.origin;
  }
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

function isM3u8Content(contentType: string, url: string, body: string): boolean {
  if (contentType.includes("mpegurl") || contentType.includes("m3u8")) return true;
  if (url.includes(".m3u8")) return true;
  const trimmed = body.trimStart();
  return trimmed.startsWith("#EXTM3U");
}

function isMpdContent(contentType: string, url: string, body: string): boolean {
  if (contentType.includes("dash+xml") || url.includes(".mpd")) return true;
  return body.trimStart().startsWith("<?xml") && body.includes("<MPD");
}

/** Exact host allowlist (seed; rotating CDNs also via CDN_SUFFIXES + session.allowedHosts). */
export const CDN_HOSTS = [
  "storm.vodvidl.site",
  "stormvv.vodvidl.site",
  "sacdn.hakunaymatata.com",
  "bcdn.hakunaymatata.com",
  "cacdn.hakunaymatata.com",
  "moon.ironbubble.site",
  "moon.ironwallnet.net",
  "infantinostreet.site",
  "ironbubble.site",
  "vixsrc.to",
  "vix-content.net",
  "hostingersite.com",
  "vidlink.pro",
  "cinepro-core",
  "streams.icefy.top",
  "scalablecontentengine.site",
  "frygarden.site",
  // Seen via CinePro / embeds — required or HLS proxy 403s segments
  "fsharetv.cc",
  "highperformancebrands.site",
  "remoteconsultinggroup.site",
  "moderncon.site",
  "moderncontentengine.site",
];

/**
 * Suffix allowlist for multi-subdomain CDNs (e.g. sc-b2-12.vix-content.net).
 * Leading-dot form: hostname must equal bare domain or end with the suffix.
 */
export const CDN_SUFFIXES = [
  ".vix-content.net",
  ".vodvidl.site",
  ".ironbubble.site",
  ".ironwallnet.net",
  ".hakunaymatata.com",
  ".hostingersite.com",
  ".vidlink.pro",
  ".icefy.top",
  ".scalablecontentengine.site",
  ".frygarden.site",
  ".workers.dev",
  ".fsharetv.cc",
  ".highperformancebrands.site",
  ".remoteconsultinggroup.site",
];

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
  return false;
}

/** Exported for standalone SSRF regression testing (scripts/ssrf-check.ts). */
export function isPrivateHostname(hostname: string): boolean {
  let lower = hostname.toLowerCase().trim();
  if (!lower) return true;
  // new URL().hostname keeps brackets on IPv6 literals ([::1]); strip them.
  if (lower.startsWith("[") && lower.endsWith("]")) lower = lower.slice(1, -1);
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;

  // IPv4 literal
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));

  // IPv6 literal
  if (lower.includes(":")) {
    if (lower === "::" || lower === "::1") return true; // unspecified / loopback
    // IPv4-mapped/embedded (e.g. ::ffff:169.254.169.254) — judge by the IPv4 tail
    const tail = lower.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (tail) return isPrivateIpv4(Number(tail[1]), Number(tail[2]));
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    return false; // other (global unicast) IPv6 is public
  }

  return false;
}

/** True when hostname is on the static CDN list or matches a known suffix. */
export function isKnownCdnHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (CDN_HOSTS.includes(h)) return true;
  for (const suffix of CDN_SUFFIXES) {
    const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    if (h === bare || h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * SSRF guard: block private IPs; allow known CDNs, root host, or hosts
 * discovered while rewriting this session's manifests (rotating segment CDNs).
 */
export function isAllowedUpstreamUrl(upstream: string, session: HlsSession): boolean {
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const hostname = parsed.hostname.toLowerCase();

  // Session root (e.g. cinepro-core) always allowed — must run BEFORE private-IP deny
  // so Docker bridge IPs used as CINEPRO_URL still work.
  try {
    const rootHost = new URL(session.rootUrl).hostname.toLowerCase();
    if (hostname === rootHost) return true;
  } catch {
    /* ignore */
  }

  if (isKnownCdnHost(hostname)) return true;
  if (session.allowedHosts.has(hostname)) return true;

  if (isPrivateHostname(hostname)) return false;

  return false;
}

const MAX_UPSTREAM_REDIRECTS = 5;
/** Bounded cooldown ladder for a CDN's transient 429 during quality/source churn. */
const UPSTREAM_RATE_LIMIT_BACKOFF_MS = [250, 750, 1_500] as const;
const MAX_UPSTREAM_RATE_LIMIT_RETRIES =
  UPSTREAM_RATE_LIMIT_BACKOFF_MS.length;
const UPSTREAM_RATE_LIMIT_RETRY_MAX_MS = 2_500;

/** Aborts when EITHER input signal aborts (Node/Bun-portable — no AbortSignal.any dependency). */
function combineAbortSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function upstreamRetryAfterMs(value: string | null, retryIndex: number): number {
  const scheduled =
    UPSTREAM_RATE_LIMIT_BACKOFF_MS[
      Math.min(retryIndex, UPSTREAM_RATE_LIMIT_BACKOFF_MS.length - 1)
    ] ?? UPSTREAM_RATE_LIMIT_BACKOFF_MS[0];
  let requested: number = scheduled;
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      requested = Math.max(scheduled, seconds * 1_000);
    } else {
      const at = Date.parse(value);
      if (Number.isFinite(at)) {
        requested = Math.max(scheduled, at - Date.now());
      }
    }
  }
  return Math.max(scheduled, Math.min(UPSTREAM_RATE_LIMIT_RETRY_MAX_MS, requested));
}

function waitForUpstreamRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fetch an upstream URL, following redirects MANUALLY and refusing any hop that
 * resolves to a private/internal host. `fetch`'s default redirect:"follow" would
 * let an allowlisted CDN 30x-bounce the proxy onto cloud-metadata / Tailscale /
 * loopback addresses (SSRF); this closes that path while still following the
 * legitimate cross-host redirects that streaming CDNs rely on.
 *
 * `clientSignal` (optional) is the incoming client request's abort signal — wired
 * up so a seek/navigate-away stops the dead upstream transfer instead of leaking it.
 */
async function discardUpstreamResponse(
  response: Response,
  reason: string
): Promise<void> {
  await response.body?.cancel(reason).catch(() => undefined);
}

async function fetchUpstreamSafely(
  url: string,
  headers: HeadersInit,
  timeoutMs: number,
  clientSignal?: AbortSignal
): Promise<Response> {
  const signal = combineAbortSignals(AbortSignal.timeout(timeoutMs), clientSignal);
  let current = url;
  let rateLimitRetries = 0;
  for (let hop = 0; hop <= MAX_UPSTREAM_REDIRECTS; hop++) {
    let res: Response;
    while (true) {
      res = await fetch(current, { headers, redirect: "manual", signal });
      if (
        res.status !== 429 ||
        rateLimitRetries >= MAX_UPSTREAM_RATE_LIMIT_RETRIES
      ) {
        break;
      }
      const retryAfterMs = upstreamRetryAfterMs(
        res.headers.get("retry-after"),
        rateLimitRetries
      );
      await discardUpstreamResponse(
        res,
        "retrying transient upstream rate limit"
      );
      rateLimitRetries += 1;
      await waitForUpstreamRetry(retryAfterMs, signal);
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    // Manual redirect responses can carry a body. Leaving it unread pins the
    // upstream socket until GC and exhausts connection reuse under
    // redirect-heavy segment traffic.
    await discardUpstreamResponse(res, "following upstream redirect");
    if (!location) return res;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return new Response("Bad upstream redirect", { status: 502 });
    }
    if (
      (next.protocol !== "http:" && next.protocol !== "https:") ||
      isPrivateHostname(next.hostname)
    ) {
      return new Response("Blocked upstream redirect", { status: 502 });
    }
    current = next.toString();
  }
  return new Response("Too many upstream redirects", { status: 502 });
}

/**
 * CinePro nested playlists often emit http://localhost:3000/v1/proxy?...
 * Remap loopback proxy URLs onto the session's CinePro origin (cinepro-core).
 */
function remapCineproLoopback(absolute: string, session: HlsSession): string {
  try {
    const u = new URL(absolute);
    const host = u.hostname.toLowerCase();
    const isLoop =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    const isProxyPath = u.pathname.includes("/v1/proxy") || u.pathname.includes("/proxy");
    if (!isLoop || !isProxyPath) return absolute;
    const root = new URL(session.rootUrl);
    u.protocol = root.protocol;
    u.hostname = root.hostname;
    u.port = root.port;
    return u.toString();
  } catch {
    return absolute;
  }
}

/** Resolve media URI → absolute, remember host, return proxy URL (or null if private/invalid). */
function rewriteToProxy(session: HlsSession, value: string, baseUrl: string): string | null {
  const decoded = value.replace(/&amp;/g, "&");
  let absolute =
    decoded.startsWith("http://") || decoded.startsWith("https://")
      ? decoded
      : resolveUrl(decoded, baseUrl);
  absolute = remapCineproLoopback(absolute, session);
  try {
    const host = new URL(absolute).hostname.toLowerCase();
    // After remap, only block private hosts that are NOT the session root.
    let rootHost = "";
    try {
      rootHost = new URL(session.rootUrl).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
    if (isPrivateHostname(host) && host !== rootHost) return null;
  } catch {
    return null;
  }
  rememberUpstreamHost(session, absolute);
  return proxyUrlFor(session, absolute);
}

/**
 * Whether an MPD attribute/BaseURL should be rewritten through the proxy.
 * Relative paths always; absolute when host is known CDN / session-allowed / any
 * non-private host (trusted because the parent MPD was already allowlisted).
 */
function isCdnPath(value: string, session: HlsSession): boolean {
  const decoded = value.replace(/&amp;/g, "&");
  if (decoded.startsWith("/sacdn/") || decoded.startsWith("/bcdn/") || decoded.startsWith("/cacdn/")) {
    return true;
  }
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
    try {
      const host = new URL(decoded).hostname.toLowerCase();
      if (isPrivateHostname(host)) return false;
      if (isKnownCdnHost(host) || session.allowedHosts.has(host)) return true;
      // Absolute media on rotating hosts (e.g. losangeles14.site) — rewrite so we can remember.
      return true;
    } catch {
      return false;
    }
  }
  // Relative path — resolve against MPD base (already allowed).
  if (!decoded.includes("://")) return true;
  return isKnownCdnHost(decoded) || CDN_HOSTS.some((h) => decoded.includes(h));
}

function rewriteSegmentAttr(value: string, session: HlsSession, baseUrl: string): string {
  return rewriteToProxy(session, value, baseUrl) ?? value.replace(/&amp;/g, "&");
}

function rewriteMpd(body: string, session: HlsSession, baseUrl: string): string {
  let result = body.replace(
    /(initialization|media|sourceURL)="([^"]+)"/g,
    (match, attr: string, value: string) => {
      if (!isCdnPath(value, session)) return match;
      return `${attr}="${rewriteSegmentAttr(value, session, baseUrl)}"`;
    }
  );

  result = result.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, value: string) => {
    const trimmed = value.trim();
    if (!isCdnPath(trimmed, session)) return match;
    const proxied = rewriteToProxy(session, trimmed, baseUrl);
    if (!proxied) return match;
    return `<BaseURL>${proxied}</BaseURL>`;
  });

  result = result.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    try {
      const abs = resolveUrl(match, baseUrl);
      const host = new URL(abs).hostname.toLowerCase();
      if (isPrivateHostname(host)) return match;
      // Only bulk-rewrite known CDN hosts here (avoid proxying non-media absolute links).
      // Media attrs / BaseURL above already rewrite rotating hosts.
      if (!isKnownCdnHost(host) && !session.allowedHosts.has(host)) return match;
      rememberUpstreamHost(session, abs);
      return proxyUrlFor(session, abs);
    } catch {
      return match;
    }
  });

  return result;
}

/**
 * Rewrite absolute/relative URIs inside HLS tags (EXT-X-MEDIA, EXT-X-STREAM-INF,
 * EXT-X-MAP, EXT-X-KEY, EXT-X-SESSION-KEY, EXT-X-I-FRAME-STREAM-INF, etc.).
 * Preserves #EXT-X-MEDIA audio/subtitle groups so hls.js can surface tracks.
 */
function rewriteTagUris(line: string, session: HlsSession, baseUrl: string): string {
  // Double-quoted URI="..." (spec-compliant)
  let out = line.replace(/URI="([^"]+)"/gi, (_m, uri: string) => {
    const proxied = rewriteToProxy(session, uri, baseUrl);
    return proxied ? `URI="${proxied}"` : _m;
  });
  // Single-quoted URI='...' (non-spec but seen in the wild)
  out = out.replace(/URI='([^']+)'/gi, (_m, uri: string) => {
    const proxied = rewriteToProxy(session, uri, baseUrl);
    return proxied ? `URI="${proxied}"` : _m;
  });
  return out;
}

function rewriteM3u8(body: string, session: HlsSession, baseUrl: string): string {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        // Tag attributes may carry media playlist URIs for AUDIO/SUBTITLES groups.
        if (/URI=/i.test(trimmed)) {
          return rewriteTagUris(trimmed, session, baseUrl);
        }
        return line;
      }

      const proxied = rewriteToProxy(session, trimmed, baseUrl);
      return proxied ?? line;
    })
    .join("\n");
}

function cachedSegmentResponse(cached: CacheEntry): Response {
  const outHeaders = new Headers();
  // private: same auth-bound reasoning as segmentOutHeaders — never public.
  outHeaders.set("Cache-Control", "private, max-age=3600");
  outHeaders.set("Content-Type", cached.contentType);
  if (cached.headers["content-range"]) outHeaders.set("Content-Range", cached.headers["content-range"]);
  if (cached.headers["content-length"]) outHeaders.set("Content-Length", cached.headers["content-length"]);
  if (cached.headers["accept-ranges"]) outHeaders.set("Accept-Ranges", cached.headers["accept-ranges"]);
  return new Response(cached.body, { status: cached.status, headers: outHeaders });
}

/**
 * Reads at most `capBytes` from `reader`. `complete` is true once EOF was reached
 * within the cap (the whole body fit); false means more bytes remained unread.
 */
async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  capBytes: number
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  while (total < capBytes) {
    const { done, value } = await reader.read();
    if (done) {
      complete = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, complete };
}

/** `Response`/BodyInit wants a concrete ArrayBuffer, not a generic ArrayBufferLike view. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Buffer a cache candidate only while it remains below the per-entry ceiling.
 *
 * Content-Length avoids creating a tee branch for an obviously huge response.
 * Chunked or misreported bodies use a bounded reader; the cache branch is
 * cancelled at the ceiling while the client-facing branch remains streamable.
 */
export async function readResponseBodyForCache(
  response: Response,
  capBytes = SEGMENT_CACHE_ENTRY_MAX_BYTES
): Promise<ArrayBuffer | null> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > capBytes) {
    metrics.oversizedSkips += 1;
    void response.body?.cancel("cache entry exceeds declared byte cap").catch(() => {});
    return null;
  }
  if (!response.body) return null;
  if (cacheBodyReadsInFlight >= CACHE_BODY_READ_MAX_CONCURRENCY) {
    metrics.saturatedSkips += 1;
    void response.body.cancel("cache reader pool saturated").catch(() => {});
    return null;
  }

  const reader = response.body.getReader();
  cacheBodyReadsInFlight += 1;
  try {
    const bounded = await readCapped(reader, capBytes + 1);
    if (!bounded.complete || bounded.bytes.byteLength > capBytes) {
      metrics.oversizedSkips += 1;
      void reader.cancel("cache entry exceeds hard byte cap").catch(() => {});
      return null;
    }
    return toArrayBuffer(bounded.bytes);
  } catch {
    void reader.cancel("cache body read failed").catch(() => {});
    return null;
  } finally {
    cacheBodyReadsInFlight = Math.max(0, cacheBodyReadsInFlight - 1);
  }
}

/**
 * Wraps an already-partially-drained reader into a Response-compatible stream:
 * replays the already-buffered `prefix` first, then resumes live reads from the
 * same underlying connection. Lets us sniff a bounded prefix without re-fetching
 * or fully buffering the remainder.
 */
function streamFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array
): ReadableStream<Uint8Array> {
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        if (prefix.byteLength > 0) controller.enqueue(prefix);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}

export interface FetchProxiedOptions {
  /**
   * When true, pure media playlists are NOT wrapped as synthetic masters.
   * Set for child requests (`media=1`) of a wrapped media playlist.
   */
  skipMediaWrap?: boolean;
}

export async function fetchProxied(
  session: HlsSession,
  upstream: string,
  rangeHeader: string | null,
  clientSignal?: AbortSignal,
  options: FetchProxiedOptions = {}
): Promise<Response> {
  // CinePro / OMSS proxy URLs have no .m3u8 extension — still may be manifests.
  // AES keys and media segments: binary passthrough only (never UTF-8 re-encode).
  const treatAsBinary =
    isKeyUrl(upstream) ||
    (isSegmentUrl(upstream) &&
      !upstream.includes(".m3u8") &&
      !upstream.includes("playlist"));

  const urlLooksLikePlaylist =
    !isKeyUrl(upstream) &&
    (upstream.includes(".m3u8") ||
      upstream.includes(".mpd") ||
      upstream.includes("playlist") ||
      // CinePro proxy may wrap either playlist OR key/segment — decide after peek
      (upstream.includes("/v1/proxy") && !isKeyUrl(upstream)));

  // VOD raw-manifest hit (incl. SWR stale): re-rewrite for this session.
  if (
    urlLooksLikePlaylist &&
    (upstream.includes(".m3u8") || upstream.includes(".mpd") || upstream.includes("playlist"))
  ) {
    const cachedManifest = await tryServeCachedManifest(session, upstream, options);
    if (cachedManifest) return cachedManifest;
  }

  // Positive body cache before negative — a prior SWR revalidate fail must not
  // shadow a still-serveable segment body.
  if (
    SEGMENT_BODY_CACHE_ENABLED &&
    !urlLooksLikePlaylist &&
    (treatAsBinary || isSegmentUrl(upstream))
  ) {
    const scope = resolveBodyCacheScope(session, upstream, "segment");
    const key = bodyCacheKey(scope.keyScope, upstream, rangeHeader);
    const cached = getCachedSegment(key);
    if (cached) {
      metrics.hits += 1;
      if (cached.stale) {
        metrics.staleHits += 1;
        revalidateSegmentInBackground(session, upstream, rangeHeader, key);
      }
      return cachedSegmentResponse(cached.entry);
    }
    metrics.misses += 1;
  }

  // Negative cache short-circuit (timeout / 5xx / ECONNRESET) — 30s.
  const negativeKind: BodyCacheKind = urlLooksLikePlaylist
    ? "manifest"
    : "segment";
  const neg = getNegativeCache(
    session,
    upstream,
    rangeHeader,
    negativeKind
  );
  if (neg) {
    metrics.negativeHits += 1;
    return new Response(neg.message, { status: neg.status });
  }

  const headers = buildUpstreamHeaders(session, upstream, rangeHeader);

  let upstreamRes: Response;
  try {
    // R10: do not bind client abort to **manifest** upstream fetches. hls.js
    // levelLoadingTimeOut can cancel a slow multi-MB media playlist mid-flight;
    // if we abort upstream too, the raw body never lands in manifest cache and
    // every retry pays the full CDN latency again (death spiral under R8 wall).
    // Segments still honor clientSignal so scrub/cancel stays responsive.
    const upstreamSignal = urlLooksLikePlaylist ? undefined : clientSignal;
    upstreamRes = await fetchUpstreamSafely(
      upstream,
      headers,
      UPSTREAM_TIMEOUT_MS,
      upstreamSignal
    );
  } catch {
    if (clientSignal?.aborted && !urlLooksLikePlaylist) {
      // Quality switches, seeks, and source changes intentionally cancel
      // obsolete segment requests. That is not an upstream failure and must
      // never poison the 30-second negative cache for the replacement
      // request. 499 truthfully records a client-closed request without
      // manufacturing a server error.
      return new Response(null, { status: 499 });
    }
    metrics.errors += 1;
    // Timeout / ECONNRESET — negative-cache so retries short-circuit for 30s.
    setNegativeCache(
      session,
      upstream,
      rangeHeader,
      negativeKind,
      502,
      "Upstream fetch failed"
    );
    return new Response("Upstream fetch failed", { status: 502 });
  }

  if (!upstreamRes.ok) {
    metrics.errors += 1;
    if (upstreamRes.status === 429) {
      let host = "unknown";
      try {
        host = new URL(upstream).hostname;
      } catch {
        /* safe fallback */
      }
      console.warn(
        JSON.stringify({
          event: "hls_upstream_rate_limited",
          host,
          kind: negativeKind,
          retries: MAX_UPSTREAM_RATE_LIMIT_RETRIES,
        })
      );
    }
    // 5xx: negative-cache after fail threshold. 4xx: pass through (auth / missing may resolve).
    if (upstreamRes.status >= 500) {
      setNegativeCache(
        session,
        upstream,
        rangeHeader,
        negativeKind,
        upstreamRes.status,
        `Upstream ${upstreamRes.status}`
      );
    }
    // Error bodies must not enter segment/manifest caches.
    await discardUpstreamResponse(
      upstreamRes,
      `discarding upstream ${upstreamRes.status} response`
    );
    return new Response(`Upstream ${upstreamRes.status}`, { status: upstreamRes.status });
  }

  clearNegativeFailStreak(
    session,
    upstream,
    rangeHeader,
    negativeKind
  );

  const contentType = mediaContentTypeForProxy(
    upstream,
    upstreamRes.headers.get("content-type") || ""
  );
  const lowerUrl = upstream.toLowerCase();
  const lowerCt = contentType.toLowerCase();

  // --- Binary key path: pass through raw bytes (AES-128 keys are 16 bytes) ---
  if (isKeyUrl(upstream)) {
    const body = await readResponseBodyForCache(upstreamRes, 64 * 1024);
    if (!body) {
      return new Response("Upstream key body too large", { status: 502 });
    }
    const out = new Headers();
    out.set("Content-Type", contentType || "application/octet-stream");
    out.set("Cache-Control", "no-store");
    out.set("Content-Length", String(body.byteLength));
    return new Response(body, { status: upstreamRes.status, headers: out });
  }

  // Media playlists from #EXT-X-MEDIA (audio/subs) often lack .m3u8 in the path
  // and may be served as text/plain — still must rewrite so tracks load via proxy.
  // Never text-sniff clear media segments (.ts/.m4s/.mp4/.aac/.vtt) — those stay binary.
  const urlLooksLikeManifest =
    lowerUrl.includes(".m3u8") ||
    lowerUrl.includes(".mpd") ||
    lowerUrl.includes("playlist") ||
    lowerUrl.includes("/subs/") ||
    lowerUrl.includes("subtitle") ||
    /\/audio[s]?[./?_-]/i.test(lowerUrl) ||
    // Only treat /v1/proxy as possible manifest when not already classified as key
    (lowerUrl.includes("/v1/proxy") && !isKeyUrl(upstream));
  const ctLooksLikeManifest =
    lowerCt.includes("mpegurl") ||
    lowerCt.includes("m3u8") ||
    lowerCt.includes("dash+xml") ||
    lowerCt.includes("application/vnd.apple");
  const ambiguousTextCt =
    lowerCt.includes("text/plain") ||
    lowerCt === "" ||
    lowerCt.includes("application/octet-stream");
  // Cap sniff size so large opaque binaries without segment extensions stay binary.
  const contentLengthHdr = Number(upstreamRes.headers.get("content-length") || 0);
  // Keys are tiny (16B) — never sniffer-re-encode them via ambiguous path
  const smallEnoughToSniff =
    contentLengthHdr === 0 ||
    (contentLengthHdr >= 64 && contentLengthHdr < 2 * 1024 * 1024);
  const likelyManifest =
    urlLooksLikeManifest ||
    ctLooksLikeManifest ||
    (ambiguousTextCt && !isSegmentUrl(upstream) && !isKeyUrl(upstream) && smallEnoughToSniff);

  if (likelyManifest) {
    if (!upstreamRes.body) {
      // No stream to sniff (e.g. 204/HEAD-like) — nothing to buffer or rewrite.
      return new Response(null, {
        status: upstreamRes.status,
        headers: segmentOutHeaders(upstreamRes, contentType || "application/octet-stream", true),
      });
    }

    // Peek a BOUNDED prefix first — never fully buffer an unknown-size body just to
    // sniff it (a chunked/oversized ".mp4 mistaken for text" body must not OOM us).
    const reader = upstreamRes.body.getReader();
    const sniffed = await readCapped(reader, MANIFEST_SNIFF_BYTES);
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      sniffed.bytes.slice(0, Math.min(sniffed.bytes.length, 64))
    );
    const looksM3u = head.trimStart().startsWith("#EXTM3U");
    const looksMpd = head.includes("<MPD") || head.trimStart().startsWith("<?xml");

    if (!looksM3u && !looksMpd) {
      // Binary (key, segment, ad) — stream the remainder through untouched instead
      // of buffering it all; bounded only by whatever we already peeked.
      const body = sniffed.complete
        ? toArrayBuffer(sniffed.bytes)
        : streamFromReader(reader, sniffed.bytes);
      return new Response(body, {
        status: upstreamRes.status,
        headers: segmentOutHeaders(
          upstreamRes,
          contentType || "application/octet-stream",
          true
        ),
      });
    }

    // Manifest-looking — buffer up to a hard ceiling so a hostile/broken upstream
    // can't force unbounded memory growth via a fake giant "manifest".
    let raw: Uint8Array;
    if (sniffed.complete) {
      raw = sniffed.bytes;
    } else {
      const rest = await readCapped(reader, MANIFEST_MAX_BYTES - sniffed.bytes.length);
      if (!rest.complete) {
        await reader.cancel().catch(() => {});
        return new Response("Upstream manifest too large", { status: 502 });
      }
      raw = new Uint8Array(sniffed.bytes.length + rest.bytes.length);
      raw.set(sniffed.bytes, 0);
      raw.set(rest.bytes, sniffed.bytes.length);
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    const rewriteBase = upstreamRes.url || upstream;

    if (isMpdContent(contentType, upstream, text) || looksMpd) {
      // Cache raw MPD only when static/uncertain-short; re-rewrite per session on hit.
      maybeCacheRawManifest(session, upstream, text, "mpd", rewriteBase);
      return buildMpdResponse(text, session, rewriteBase);
    }
    if (isM3u8Content(contentType, upstream, text) || looksM3u) {
      // Store RAW playlist (not rewritten) so hits re-embed the requesting session id.
      // RESOLUTION inject / media wrap is applied on the response path only (not stored raw).
      maybeCacheRawManifest(session, upstream, text, "m3u8", rewriteBase);
      return buildM3u8Response(session, upstream, text, rewriteBase, {
        skipMediaWrap: options.skipMediaWrap === true,
      });
    }

    return new Response(toArrayBuffer(raw), {
      status: upstreamRes.status,
      headers: segmentOutHeaders(upstreamRes, contentType, true),
    });
  }

  // Known media segment: stream first byte immediately. Production does not
  // clone media bodies while the in-process cache is disabled.
  if (isSegmentUrl(upstream) && upstreamRes.body) {
    const outHeaders = segmentOutHeaders(upstreamRes, contentType, true);
    if (SEGMENT_BODY_CACHE_ENABLED) {
      try {
        const cacheClone = upstreamRes.clone();
        cacheSegmentAsync(
          session,
          upstream,
          rangeHeader,
          upstreamRes.status,
          contentType,
          pickPassthroughHeaders(upstreamRes),
          readResponseBodyForCache(cacheClone)
        );
      } catch {
        /* clone unavailable - still stream without caching */
      }
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: outHeaders,
    });
  }

  // Non-segment binary with a body stream (e.g. CinePro /v1/proxy-wrapped .mp4 rungs
  // that don't match isSegmentUrl by extension): stream through untouched rather than
  // buffering a potentially large/unknown-size body into memory.
  if (upstreamRes.body) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: segmentOutHeaders(upstreamRes, contentType, isSegmentUrl(upstream)),
    });
  }

  // No body stream available (rare) — bounded buffer read is the only option.
  const bodyBuffer = await upstreamRes.arrayBuffer();
  if (SEGMENT_BODY_CACHE_ENABLED && isSegmentUrl(upstream)) {
    cacheSegmentAsync(
      session,
      upstream,
      rangeHeader,
      upstreamRes.status,
      contentType,
      pickPassthroughHeaders(upstreamRes),
      Promise.resolve(bodyBuffer)
    );
  }

  return new Response(bodyBuffer, {
    status: upstreamRes.status,
    headers: segmentOutHeaders(upstreamRes, contentType, isSegmentUrl(upstream)),
  });
}

export function buildPlaybackProxyUrl(session: HlsSession): string {
  return proxyUrlFor(session, session.rootUrl);
}
