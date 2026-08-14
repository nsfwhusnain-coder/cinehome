/**
 * Measured latency / throughput probes for stream sources.
 * Runs on the scraper host (same network as HLS proxy). Fast path must skip this.
 */

import { isImplausibleEmbedDuration } from "./embed-duration";
import { isPoisonStreamUrl } from "./poison-url";
import { safeStreamTarget, type StreamPathKind } from "./safe-url-summary";
import { hlsMediaDurationSeconds } from "../../src/lib/playback/media-duration";
import type { MediaType } from "../../src/lib/playback/types";

export interface ProbeSession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders?: Record<string, string>;
}

export interface ProbeableEntry {
  url: string;
  session: ProbeSession;
}

export interface ProbeResult {
  ok: boolean;
  ttfbMs: number;
  bytesPerSec: number;
  speedScore: number;
  error?: string;
  /** Sum of EXTINF durations when the probe reached an HLS media playlist. */
  durationS?: number;
}

const PROBE_BYTE_CAP = 65_536;
const PROBE_MIN_BYTES_HLS = 500;
const PROBE_MIN_BYTES_MP4 = 200;
const PROBE_TIMEOUT_MS = 5_000;
/** Successes stay cached longer; failures expire quickly so transient blips recover. */
const PROBE_CACHE_SUCCESS_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_FAILURE_TTL_MS = 90 * 1000;
/** Keep a rejected preview out of concurrent/cache merges for the signed-URL lifetime. */
const TRUNCATED_SOURCE_TTL_MS = 30 * 60 * 1000;
const PROBE_MAX_CONCURRENT = 3;
const PROBE_MAX_PER_SCRAPE = 8;
const PROBE_GLOBAL_BUDGET_MS = 12_000;
const TTFB_GOOD_MS = 250;
const THRUPUT_GOOD_BPS = 2_500_000;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Match scraper CDN_REFERERS so probe path equals play path. */
const CDN_REFERERS: Record<string, string> = {
  "moon.ironbubble.site": "https://www.vidking.net/",
  "infantinostreet.site": "https://www.vidking.net/",
  "ironbubble.site": "https://www.vidking.net/",
  "moon.ironwallnet.net": "https://www.vidking.net/",
  "ironwallnet.net": "https://www.vidking.net/",
  "storm.vodvidl.site": "https://vidlink.pro/",
  "sacdn.hakunaymatata.com": "https://vidlink.pro/",
  "bcdn.hakunaymatata.com": "https://vidlink.pro/",
};

interface CacheEntry {
  result: ProbeResult;
  expiresAt: number;
}

const probeCache = new Map<string, CacheEntry>();
const truncatedSourceCache = new Map<string, number>();

export interface ProbeBatchSummary {
  at: number;
  probed: number;
  okCount: number;
  bestScore: number | null;
  bestHost: string | null;
  bestPathKind: StreamPathKind;
  budgetHit: boolean;
  durationMs: number;
}

let lastProbeSummary: ProbeBatchSummary | null = null;

export function getLastProbeSummary(): ProbeBatchSummary | null {
  return lastProbeSummary;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function urlCacheKey(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function refererForCdn(targetUrl: string, referer: string): string {
  try {
    const host = new URL(targetUrl).hostname;
    return CDN_REFERERS[host] || referer;
  } catch {
    return referer;
  }
}

function buildHeaders(entry: ProbeableEntry, targetUrl: string): Record<string, string> {
  const effectiveReferer = refererForCdn(targetUrl, entry.session.referer || "");
  let origin = entry.session.origin || effectiveReferer;
  try {
    origin = new URL(effectiveReferer).origin;
  } catch {
    /* keep */
  }
  const headers: Record<string, string> = {
    Referer: effectiveReferer,
    Origin: origin,
    "User-Agent": entry.session.userAgent || DEFAULT_UA,
    Accept: "*/*",
    ...(entry.session.extraHeaders ?? {}),
  };
  if (entry.session.cookies) headers.Cookie = entry.session.cookies;
  return headers;
}

function computeSpeedScore(ttfbMs: number, bytesPerSec: number): number {
  const ttfbScore = clamp(100 * (TTFB_GOOD_MS / Math.max(ttfbMs, 1)), 0, 100);
  const thruputScore = clamp(100 * (bytesPerSec / THRUPUT_GOOD_BPS), 0, 100);
  return Math.round(0.55 * ttfbScore + 0.45 * thruputScore);
}

function failResult(error: string, ttfbMs = 0): ProbeResult {
  return { ok: false, ttfbMs, bytesPerSec: 0, speedScore: 0, error };
}

function cacheProbeResult(key: string, result: ProbeResult): void {
  const ttl = result.ok ? PROBE_CACHE_SUCCESS_TTL_MS : PROBE_CACHE_FAILURE_TTL_MS;
  probeCache.set(key, { result, expiresAt: Date.now() + ttl });
}

function resolveUrl(base: string, ref: string): string {
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

function isMasterPlaylist(text: string): boolean {
  return text.split("\n").some((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
}

function isMediaPlaylist(text: string): boolean {
  return text.includes("#EXTINF") || text.includes("#EXT-X-TARGETDURATION");
}

/** First media URI from HLS playlist; prefers non-HEVC ~1080p. */
function pickMediaPlaylistUri(text: string, playlistUrl: string): string | null {
  const lines = text.split("\n").map((l) => l.trim());
  if (!lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) return null;

  type Variant = { uri: string; bandwidth: number; height: number; hevc: boolean };
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const next = lines[i + 1];
    if (!next || next.startsWith("#")) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
    const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
    const codecs = (line.match(/CODECS="([^"]+)"/i)?.[1] ?? "").toLowerCase();
    variants.push({
      uri: resolveUrl(playlistUrl, next),
      bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
      height: resMatch ? Number(resMatch[1]) : 0,
      hevc: codecs.includes("hvc1") || codecs.includes("hev1") || codecs.includes("h265"),
    });
  }
  if (!variants.length) return null;

  const nonHevc = variants.filter((v) => !v.hevc);
  const pool = nonHevc.length ? nonHevc : variants;
  // Prefer mid rungs (Horizon 5-style nested masters often break on top bitrate).
  const under720 = pool.filter((v) => v.height > 0 && v.height <= 720);
  const under1080 = pool.filter((v) => v.height > 0 && v.height <= 1080);
  const pickFrom = under720.length ? under720 : under1080.length ? under1080 : pool;
  pickFrom.sort(
    (a, b) => Math.abs(a.bandwidth - 2_500_000) - Math.abs(b.bandwidth - 2_500_000)
  );
  return pickFrom[0]?.uri ?? null;
}

function firstSegmentUri(text: string, playlistUrl: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return resolveUrl(playlistUrl, line);
  }
  return null;
}

/**
 * Walk master → (nested master)* → media playlist that has #EXTINF.
 * CinePro/VidApi often nests two masters; one hop left us probing a playlist as a "segment".
 */
async function resolveToMediaPlaylist(
  entry: ProbeableEntry,
  startUrl: string,
  startText: string
): Promise<{ url: string; text: string; ttfbMs: number } | { error: string; ttfbMs: number }> {
  let url = startUrl;
  let text = startText;
  let ttfbMs = 0;
  const maxHops = 4;

  for (let hop = 0; hop < maxHops; hop++) {
    if (isMediaPlaylist(text) && !isMasterPlaylist(text)) {
      return { url, text, ttfbMs };
    }
    if (!isMasterPlaylist(text)) {
      // Single-level media without STREAM-INF
      if (isMediaPlaylist(text)) return { url, text, ttfbMs };
      return { error: "not an HLS media playlist", ttfbMs };
    }
    const next = pickMediaPlaylistUri(text, url);
    if (!next) return { error: "no variants in master", ttfbMs };
    const headers = buildHeaders(entry, next);
    const res = await timedFetch(next, headers, { asText: true });
    ttfbMs = res.ttfbMs || ttfbMs;
    if (!res.ok || !res.text?.includes("#EXTM3U")) {
      return {
        error: res.error || `media playlist http ${res.status}`,
        ttfbMs,
      };
    }
    url = next;
    text = res.text;
  }
  if (isMediaPlaylist(text)) return { url, text, ttfbMs };
  return { error: "nested master depth exceeded", ttfbMs };
}

/**
 * URL-only HLS hint. CinePro `/v1/proxy` wraps BOTH masters and progressive
 * MP4s (Fshare/Share) — never treat the proxy path as HLS by name.
 * Real HLS is `.m3u8` / mpegurl, or a sniffed `#EXTM3U` / mpegurl Content-Type.
 */
export function looksLikeHlsUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes(".m3u8") || lower.includes("mpegurl");
}

function contentTypeLooksHls(contentType: string | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl");
}

function contentTypeLooksDash(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("dash+xml");
}

function contentTypeLooksProgressive(contentType: string | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return (
    ct.startsWith("video/mp4") ||
    ct.startsWith("video/webm") ||
    ct.startsWith("video/quicktime") ||
    ct.includes("octet-stream")
  );
}

function bodyLooksHls(body: string | undefined): boolean {
  return Boolean(body && body.includes("#EXTM3U"));
}

function bodyLooksDash(body: string | undefined): boolean {
  return Boolean(body && body.includes("<MPD"));
}

function bodyLooksProgressive(body: string | undefined): boolean {
  if (!body) return false;
  return body.includes("ftyp") || body.includes("moof") || body.includes("mdat");
}

/**
 * Classify a probe target from URL + optional Content-Type / body sniff.
 * `/v1/proxy` of an MP4 is progressive; only actual HLS signals select HLS.
 */
export function classifyProbeKind(
  url: string,
  contentType?: string,
  body?: string
): "hls" | "dash" | "progressive" {
  if (bodyLooksHls(body) || contentTypeLooksHls(contentType)) return "hls";
  if (bodyLooksDash(body) || contentTypeLooksDash(contentType)) return "dash";
  if (bodyLooksProgressive(body) || contentTypeLooksProgressive(contentType)) {
    return "progressive";
  }
  const lower = url.toLowerCase();
  if (lower.includes(".mpd")) return "dash";
  if (looksLikeHlsUrl(url)) return "hls";
  return "progressive";
}

/** Reject "segments" that are still playlists / ads / images (false-positive scores). */
function isLikelyMediaSegment(bytes: number, status: number, sampleText?: string): boolean {
  if (!(status === 200 || status === 206)) return false;
  if (bytes < PROBE_MIN_BYTES_HLS) return false;
  if (sampleText) {
    const raw = sampleText;
    const head = raw.trimStart().slice(0, 32);
    if (head.startsWith("#EXTM3U") || head.startsWith("<?xml") || head.startsWith("<MPD")) {
      return false;
    }
    if (head.toLowerCase().startsWith("<!doctype") || head.toLowerCase().startsWith("<html")) {
      return false;
    }
    // Icefy/Aether often injects PNG/JPEG ad tiles as first "segment"
    if (
      raw.startsWith("\u0089PNG") ||
      raw.startsWith("PNG") ||
      raw.includes("IHDR") && raw.includes("PNG") ||
      raw.startsWith("\u00ff\u00d8\u00ff") || // JPEG
      raw.startsWith("GIF8") ||
      raw.startsWith("RIFF")
    ) {
      return false;
    }
    // MPEG-TS sync byte 0x47 is common for real HLS segments
    const b0 = raw.charCodeAt(0);
    if (b0 === 0x47 || b0 === 0x00 || b0 === 0x01 || b0 === 0x1a) {
      return true;
    }
    // ftyp box (mp4/fmp4)
    if (raw.includes("ftyp") || raw.includes("moof") || raw.includes("mdat")) return true;
  }
  return true;
}

function xmlAttr(fragment: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fragment.match(new RegExp(`\\b${escaped}="([^"]+)"`, "i"))?.[1] ?? null;
}

function expandDashTemplate(
  template: string,
  values: {
    representationId: string;
    bandwidth: string;
    number: number;
    time: number;
  }
): string | null {
  const expanded = template
    .replace(/\$\$/g, "\u0000")
    .replace(
      /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
      (_match, key: string, widthRaw?: string) => {
        const raw =
          key === "RepresentationID"
            ? values.representationId
            : key === "Bandwidth"
              ? values.bandwidth
              : String(key === "Number" ? values.number : values.time);
        const width = Number(widthRaw || 0);
        return width > 0 ? raw.padStart(width, "0") : raw;
      }
    )
    .replace(/\u0000/g, "$");
  return expanded.includes("$") ? null : expanded;
}

/**
 * Resolve a real first DASH media URL. Returning the MPD itself made a quick,
 * 200-byte manifest look like a successful segment whenever SegmentTemplate
 * used normal `$RepresentationID$` / `$Number$` placeholders.
 */
export function firstDashMediaUrl(mpd: string, manifestUrl: string): string | null {
  const representation =
    [...mpd.matchAll(/<Representation\b([^>]*)>/gi)].find((match) =>
      /\b(?:height|mimeType="video|contentType="video|codecs="(?:avc|hvc|hev|vp|av01))/i.test(
        match[1] || ""
      )
    ) ?? mpd.match(/<Representation\b([^>]*)>/i);
  const repAttrs = representation?.[1] ?? "";
  const representationId = xmlAttr(repAttrs, "id") ?? "";
  const bandwidth = xmlAttr(repAttrs, "bandwidth") ?? "";

  const segmentTemplate =
    [...mpd.matchAll(/<SegmentTemplate\b([^>]*)>/gi)].find((match) =>
      /\bmedia="/i.test(match[1] || "")
    )?.[1] ?? "";
  const media = xmlAttr(segmentTemplate, "media");
  const initialization = xmlAttr(segmentTemplate, "initialization");
  const startNumber = Number(xmlAttr(segmentTemplate, "startNumber") || "1");
  const firstTimelineTime = Number(
    mpd.match(/<S\b[^>]*\bt="(\d+)"/i)?.[1] || "0"
  );

  const baseValues = [...mpd.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  let resolvedBase = manifestUrl;
  for (const value of baseValues.slice(0, 2)) {
    resolvedBase = resolveUrl(resolvedBase, value);
    if (/\.(?:mp4|m4s|cmfv)(?:\?|$)/i.test(resolvedBase)) {
      return resolvedBase;
    }
  }

  for (const template of [media, initialization]) {
    if (!template) continue;
    const expanded = expandDashTemplate(template, {
      representationId,
      bandwidth,
      number: Number.isFinite(startNumber) ? startNumber : 1,
      time: Number.isFinite(firstTimelineTime) ? firstTimelineTime : 0,
    });
    if (expanded) return resolveUrl(resolvedBase, expanded);
  }
  return null;
}

interface TimedBody {
  ok: boolean;
  status: number;
  ttfbMs: number;
  bytes: number;
  bytesPerSec: number;
  text?: string;
  contentType?: string;
  error?: string;
}

async function timedFetch(
  url: string,
  headers: Record<string, string>,
  options: { range?: boolean; asText?: boolean; timeoutMs?: number } = {}
): Promise<TimedBody> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const reqHeaders: Record<string, string> = { ...headers };
  if (options.range) {
    reqHeaders.Range = `bytes=0-${PROBE_BYTE_CAP - 1}`;
  }

  try {
    const res = await fetch(url, {
      headers: reqHeaders,
      signal: controller.signal,
      redirect: "follow",
    });
    const tHeaders = performance.now();
    const contentType = res.headers.get("content-type") ?? "";

    if (options.asText) {
      const text = await res.text();
      const tEnd = performance.now();
      const ttfbMs = tHeaders - t0;
      const bytes = new TextEncoder().encode(text).byteLength;
      const thruputMs = Math.max(tEnd - tHeaders, 1);
      return {
        ok: res.ok || res.status === 206,
        status: res.status,
        ttfbMs,
        bytes,
        bytesPerSec: (bytes / thruputMs) * 1000,
        text,
        contentType,
      };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const buf = await res.arrayBuffer();
      const tEnd = performance.now();
      const ttfbMs = tHeaders - t0;
      const bytes = Math.min(buf.byteLength, PROBE_BYTE_CAP);
      const thruputMs = Math.max(tEnd - tHeaders, 1);
      return {
        ok: (res.ok || res.status === 206) && bytes >= PROBE_MIN_BYTES_MP4,
        status: res.status,
        ttfbMs,
        bytes,
        bytesPerSec: (bytes / thruputMs) * 1000,
        contentType,
      };
    }

    let bytes = 0;
    let tFirst = 0;
    while (bytes < PROBE_BYTE_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!tFirst && value?.byteLength) tFirst = performance.now();
      bytes += value?.byteLength ?? 0;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    const tEnd = performance.now();
    const ttfbMs = (tFirst || tHeaders) - t0;
    const thruputMs = Math.max(tEnd - (tFirst || tHeaders), 1);
    const httpOk = res.ok || res.status === 206;
    return {
      ok: httpOk,
      status: res.status,
      ttfbMs,
      bytes: Math.min(bytes, PROBE_BYTE_CAP),
      bytesPerSec: (Math.min(bytes, PROBE_BYTE_CAP) / thruputMs) * 1000,
      contentType,
    };
  } catch (e) {
    const ttfbMs = performance.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    const error =
      controller.signal.aborted || /abort|timeout/i.test(msg) ? "timeout" : msg.slice(0, 120);
    return {
      ok: false,
      status: 0,
      ttfbMs,
      bytes: 0,
      bytesPerSec: 0,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHls(entry: ProbeableEntry): Promise<ProbeResult> {
  const headers = buildHeaders(entry, entry.url);
  const pl = await timedFetch(entry.url, headers, { asText: true });
  if (!pl.ok || !pl.text?.includes("#EXTM3U")) {
    return failResult(pl.error || `playlist http ${pl.status}`, pl.ttfbMs);
  }

  const media = await resolveToMediaPlaylist(entry, entry.url, pl.text);
  if ("error" in media) {
    return failResult(media.error, media.ttfbMs || pl.ttfbMs);
  }

  const segUrl = firstSegmentUri(media.text, media.url);
  if (!segUrl) {
    return failResult("empty playlist", media.ttfbMs || pl.ttfbMs);
  }

  // Peek without Range first few bytes to reject nested playlists mislabeled as segments.
  const segHeaders = buildHeaders(entry, segUrl);
  const peek = await timedFetch(segUrl, segHeaders, {
    range: true,
    asText: true,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (
    peek.text &&
    (peek.text.trimStart().startsWith("#EXTM3U") || peek.text.includes("#EXT-X-STREAM-INF"))
  ) {
    // One more hop: treat peek body as nested playlist
    const nested = await resolveToMediaPlaylist(entry, segUrl, peek.text);
    if ("error" in nested) {
      return failResult(nested.error || "segment was nested playlist", peek.ttfbMs);
    }
    const realSeg = firstSegmentUri(nested.text, nested.url);
    if (!realSeg) return failResult("empty nested playlist", nested.ttfbMs);
    const realHeaders = buildHeaders(entry, realSeg);
    const seg = await timedFetch(realSeg, realHeaders, { range: true });
    const ok = isLikelyMediaSegment(seg.bytes, seg.status);
    const durationS = hlsMediaDurationSeconds(nested.text);
    return {
      ok,
      ttfbMs: Math.round(seg.ttfbMs),
      bytesPerSec: Math.round(seg.bytesPerSec),
      speedScore: ok ? computeSpeedScore(seg.ttfbMs, seg.bytesPerSec) : 0,
      error: ok ? undefined : seg.error || `http ${seg.status}`,
      ...(durationS > 0 ? { durationS } : {}),
    };
  }

  const ok = isLikelyMediaSegment(peek.bytes, peek.status, peek.text);
  const durationS = hlsMediaDurationSeconds(media.text);
  return {
    ok,
    ttfbMs: Math.round(peek.ttfbMs),
    bytesPerSec: Math.round(peek.bytesPerSec),
    speedScore: ok ? computeSpeedScore(peek.ttfbMs, peek.bytesPerSec) : 0,
    error: ok ? undefined : peek.error || `http ${peek.status}`,
    ...(durationS > 0 ? { durationS } : {}),
  };
}

export function isKnownTruncatedSource(url: string): boolean {
  const key = urlCacheKey(url);
  const expiresAt = truncatedSourceCache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    truncatedSourceCache.delete(key);
    return false;
  }
  return true;
}

function rememberTruncatedSource(url: string): void {
  truncatedSourceCache.set(urlCacheKey(url), Date.now() + TRUNCATED_SOURCE_TTL_MS);
}

function applyDurationExpectation(
  sourceUrl: string,
  result: ProbeResult,
  mediaType: MediaType | undefined,
  expectedDurationS: number | undefined
): ProbeResult {
  if (
    !result.ok ||
    mediaType == null ||
    expectedDurationS == null ||
    !Number.isFinite(expectedDurationS) ||
    expectedDurationS <= 0 ||
    result.durationS == null ||
    !Number.isFinite(result.durationS) ||
    result.durationS <= 0
  ) {
    return result;
  }
  if (!isImplausibleEmbedDuration(result.durationS, expectedDurationS, mediaType)) {
    truncatedSourceCache.delete(urlCacheKey(sourceUrl));
    return result;
  }
  rememberTruncatedSource(sourceUrl);
  return {
    ...result,
    ok: false,
    speedScore: 0,
    error: "implausibly_short_duration",
  };
}

async function probeOne(entry: ProbeableEntry): Promise<ProbeResult> {
  const key = urlCacheKey(entry.url);
  const cached = probeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result };
  }

  // Never mark poison hosts / PHP wrappers as probe.ok — skip network entirely.
  if (isPoisonStreamUrl(entry.url)) {
    const result = failResult("poison_url");
    cacheProbeResult(key, result);
    return result;
  }

  const headers = buildHeaders(entry, entry.url);

  try {
    // Strong URL hint only (.m3u8 / mpegurl). CinePro /v1/proxy is sniffed —
    // assuming HLS made Fshare MP4s fail with "playlist http 200".
    if (looksLikeHlsUrl(entry.url)) {
      const result = await probeHls(entry);
      cacheProbeResult(key, result);
      return result;
    }

    // Sniff Content-Type / body: HLS if #EXTM3U or mpegurl, else progressive.
    const sniff = await timedFetch(entry.url, headers, { asText: true, range: true });
    const kind = classifyProbeKind(entry.url, sniff.contentType, sniff.text);
    if (kind === "hls") {
      const result = await probeHls(entry);
      cacheProbeResult(key, result);
      return result;
    }
    if (kind === "dash") {
      const mpd = sniff.text?.includes("<MPD")
        ? sniff
        : await timedFetch(entry.url, headers, { asText: true });
      if (!mpd.ok || !mpd.text?.includes("<MPD")) {
        const result = failResult(mpd.error || `mpd http ${mpd.status}`, mpd.ttfbMs);
        cacheProbeResult(key, result);
        return result;
      }
      const mediaUrl = firstDashMediaUrl(mpd.text, entry.url);
      if (!mediaUrl) {
        const result = failResult("dash_media_unresolved", mpd.ttfbMs);
        cacheProbeResult(key, result);
        return result;
      }
      const mediaHeaders = buildHeaders(entry, mediaUrl);
      const seg = await timedFetch(mediaUrl, mediaHeaders, { range: true });
      const minOk = seg.bytes >= PROBE_MIN_BYTES_MP4;
      const ok = seg.ok && minOk;
      const result: ProbeResult = {
        ok,
        ttfbMs: Math.round(seg.ttfbMs),
        bytesPerSec: Math.round(seg.bytesPerSec),
        speedScore: ok ? computeSpeedScore(seg.ttfbMs, seg.bytesPerSec) : 0,
        error: ok ? undefined : seg.error || (minOk ? `http ${seg.status}` : "empty"),
      };
      cacheProbeResult(key, result);
      return result;
    }

    // Progressive MP4 / direct (only when not playlist)
    const seg = sniff.ok
      ? sniff
      : await timedFetch(entry.url, headers, { range: true });
    const head = (seg.text ?? "").trimStart().slice(0, 32).toLowerCase();
    const looksHtml =
      head.startsWith("<!doctype") ||
      head.startsWith("<html") ||
      head.startsWith("<head") ||
      head.startsWith("<?xml");
    const minOk = seg.bytes >= PROBE_MIN_BYTES_MP4;
    const ok =
      seg.ok && minOk && !seg.text?.includes("#EXTM3U") && !looksHtml;
    const result: ProbeResult = {
      ok,
      ttfbMs: Math.round(seg.ttfbMs),
      bytesPerSec: Math.round(seg.bytesPerSec),
      speedScore: ok ? computeSpeedScore(seg.ttfbMs, seg.bytesPerSec) : 0,
      error: ok
        ? undefined
        : looksHtml
          ? "html_body"
          : seg.error || (minOk ? `http ${seg.status}` : "empty"),
    };
    cacheProbeResult(key, result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const result = failResult(msg.slice(0, 120));
    cacheProbeResult(key, result);
    return result;
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!, i);
    }
  }

  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

/**
 * Probe up to PROBE_MAX_PER_SCRAPE entries (concurrency 3, 12s budget).
 * Returns ProbeResult map keyed by source url. Unprobed urls are omitted.
 */
export async function probeSourceBatch(
  entries: ProbeableEntry[],
  options: {
    maxSources?: number;
    mediaType?: MediaType;
    expectedDurationS?: number;
  } = {}
): Promise<Map<string, ProbeResult>> {
  const maxSources = options.maxSources ?? PROBE_MAX_PER_SCRAPE;
  const selected = entries.slice(0, maxSources);
  const out = new Map<string, ProbeResult>();
  if (!selected.length) return out;

  const batchStarted = Date.now();
  const deadline = batchStarted + PROBE_GLOBAL_BUDGET_MS;
  let budgetHit = false;

  await mapPool(selected, PROBE_MAX_CONCURRENT, async (entry) => {
    if (Date.now() > deadline) {
      budgetHit = true;
      out.set(entry.url, failResult("budget"));
      return;
    }
    const result = await probeOne(entry);
    out.set(
      entry.url,
      applyDurationExpectation(
        entry.url,
        result,
        options.mediaType,
        options.expectedDurationS
      )
    );
  });

  const values = [...out.values()];
  const okOnes = values.filter((r) => r.ok);
  let bestScore: number | null = null;
  let bestUrl: string | null = null;
  for (const [url, r] of out) {
    if (!r.ok) continue;
    if (bestScore == null || r.speedScore > bestScore) {
      bestScore = r.speedScore;
      bestUrl = url;
    }
  }

  const bestTarget = safeStreamTarget(bestUrl);
  lastProbeSummary = {
    at: Date.now(),
    probed: out.size,
    okCount: okOnes.length,
    bestScore,
    bestHost: bestTarget.host,
    bestPathKind: bestTarget.pathKind,
    budgetHit,
    durationMs: Date.now() - batchStarted,
  };

  return out;
}
