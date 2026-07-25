/**
 * Real quality capture — full scrape path only (never fast=1, TTFF-critical).
 * Mirrors probe.ts's latency prober in shape/conventions, but pulls the actual
 * rendition ladder / max height out of the manifest instead of timing bytes.
 *
 * Every value here comes from either a fetched manifest (EXT-X-STREAM-INF
 * RESOLUTION=WxH, or a DASH height attr) or an unambiguous URL path/name token
 * (/1080/, 1080p, …). Nothing is guessed beyond that — unprobed/failed sources
 * keep maxHeight 0 (unknown, not bad).
 */

export type StreamKind = "hls" | "mp4" | "dash";

/**
 * Provenance of maxHeight / ladder on a source entry.
 * - manifest: HLS EXT-X-STREAM-INF RESOLUTION or DASH height attrs
 * - label: URL path / label / quality token only (no network or after media confirm)
 * - probe: network quality probe classified the stream; height from media+token path
 * - unknown: probed or classified but height still unknown
 */
export type QualitySource = "manifest" | "label" | "probe" | "unknown";

export interface QualitySession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders?: Record<string, string>;
}

export interface QualityProbeEntry {
  url: string;
  label: string;
  quality: string;
  provider: string;
  session: QualitySession;
}

export interface QualityInfo {
  type: StreamKind;
  maxHeight: number;
  ladder: number[];
  qualitySource: QualitySource;
}

const QUALITY_PROBE_TIMEOUT_MS = 3_000;
const QUALITY_PROBE_CONCURRENCY = 5;
/** Network fetches per scrape (mp4 entries are free — classified without a fetch). */
const QUALITY_PROBE_MAX_NETWORK = 12;
const QUALITY_PROBE_GLOBAL_BUDGET_MS = 10_000;
const QUALITY_CACHE_SUCCESS_TTL_MS = 30 * 60 * 1000;
const QUALITY_CACHE_FAILURE_TTL_MS = 2 * 60 * 1000;
/** Bounded partial read for DASH manifests — enough for early height attrs, no full download. */
const DASH_BYTE_CAP = 24_000;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Same CDN referer overrides as probe.ts — keep probe path == play path. */
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
  info: QualityInfo;
  expiresAt: number;
}

const qualityCache = new Map<string, CacheEntry>();

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

function buildHeaders(session: QualitySession, targetUrl: string): Record<string, string> {
  const effectiveReferer = refererForCdn(targetUrl, session.referer || "");
  let origin = session.origin || effectiveReferer;
  try {
    origin = new URL(effectiveReferer).origin;
  } catch {
    /* keep */
  }
  const headers: Record<string, string> = {
    Referer: effectiveReferer,
    Origin: origin,
    "User-Agent": session.userAgent || DEFAULT_UA,
    Accept: "*/*",
    ...(session.extraHeaders ?? {}),
  };
  if (session.cookies) headers.Cookie = session.cookies;
  return headers;
}

/** Unambiguous URL path/name token → height. Never guesses beyond an exact token. */
export function inferHeightFromUrl(text: string): number {
  const lower = text.toLowerCase();
  if (/\b4k\b/.test(lower)) return 2160;
  const pathToken = lower.match(/[\/_-](2160|1440|1080|720|480|360)p?(?:[\/_.?&-]|$)/);
  if (pathToken) return Number(pathToken[1]);
  const pToken = lower.match(/\b(2160|1440|1080|720|480|360)p\b/);
  if (pToken) return Number(pToken[1]);
  return 0;
}

/** Cheap URL/label/quality-based stream-kind classification (no network). */
export function classifyStreamKind(url: string, label = "", quality = ""): StreamKind {
  const lower = url.toLowerCase();
  const lbl = label.trim().toLowerCase();
  const q = quality.trim().toLowerCase();
  if (lbl === "dash" || q === "dash" || lower.includes(".mpd")) return "dash";
  if (lbl.startsWith("share") || q === "mp4" || q === "file") return "mp4";
  if (lower.includes(".m3u8")) return "hls";
  if (lower.includes(".mp4") && !lower.includes(".m3u8")) return "mp4";
  return "hls";
}

/** Pure — every EXT-X-STREAM-INF RESOLUTION=WxH height, unique, desc. Testable without network. */
export function parseHlsMasterLadder(manifestText: string): number[] {
  const heights = new Set<number>();
  for (const raw of manifestText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const m = line.match(/RESOLUTION=\d+x(\d+)/i);
    if (m) heights.add(Number(m[1]));
  }
  return Array.from(heights).sort((a, b) => b - a);
}

export function isHlsMasterManifest(text: string): boolean {
  return text.split("\n").some((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
}

export function isHlsMediaManifest(text: string): boolean {
  return text.includes("#EXTINF") || text.includes("#EXT-X-TARGETDURATION");
}

/** Cheap bounded DASH height scrape — regex is enough for `height="N"`, no XML parser needed. */
export function parseDashLadder(mpdText: string): number[] {
  const heights = new Set<number>();
  const re = /height="(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mpdText))) {
    const h = Number(m[1]);
    if (h > 0) heights.add(h);
  }
  return Array.from(heights).sort((a, b) => b - a);
}

async function fetchManifestText(
  url: string,
  headers: Record<string, string>,
  byteCap?: number
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUALITY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    if (!res.ok && res.status !== 206) return null;
    if (!byteCap) return await res.text();
    const reader = res.body?.getReader();
    if (!reader) return (await res.text()).slice(0, byteCap);
    const decoder = new TextDecoder();
    let out = "";
    while (out.length < byteCap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withLadderMax(info: QualityInfo): QualityInfo {
  // Always stamp maxHeight when ladder[0] is known (clients key off maxHeight).
  if (info.ladder.length > 0 && (info.maxHeight <= 0 || info.maxHeight < info.ladder[0]!)) {
    return { ...info, maxHeight: info.ladder[0]! };
  }
  return info;
}

async function probeQualityOne(entry: QualityProbeEntry): Promise<QualityInfo> {
  const key = urlCacheKey(entry.url);
  const cached = qualityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.info };

  const kind = classifyStreamKind(entry.url, entry.label, entry.quality);
  const tokenHeight = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
  let info: QualityInfo;

  if (kind === "mp4") {
    // Progressive — no manifest to fetch; URL/label token is the only real signal.
    const maxHeight = tokenHeight;
    info = {
      type: "mp4",
      maxHeight,
      ladder: [],
      qualitySource: maxHeight > 0 ? "label" : "unknown",
    };
  } else if (kind === "dash") {
    const headers = buildHeaders(entry.session, entry.url);
    const text = await fetchManifestText(entry.url, headers, DASH_BYTE_CAP);
    const ladder = text ? parseDashLadder(text) : [];
    if (ladder.length > 0) {
      info = {
        type: "dash",
        maxHeight: ladder[0]!,
        ladder,
        qualitySource: "manifest",
      };
    } else if (tokenHeight > 0) {
      // Network empty / failed; height still only from unambiguous tokens.
      info = {
        type: "dash",
        maxHeight: tokenHeight,
        ladder: [],
        qualitySource: text ? "probe" : "label",
      };
    } else {
      info = { type: "dash", maxHeight: 0, ladder: [], qualitySource: "unknown" };
    }
  } else {
    const headers = buildHeaders(entry.session, entry.url);
    const text = await fetchManifestText(entry.url, headers);
    if (text && isHlsMasterManifest(text)) {
      const ladder = parseHlsMasterLadder(text);
      if (ladder.length > 0) {
        info = {
          type: "hls",
          maxHeight: ladder[0]!,
          ladder,
          qualitySource: "manifest",
        };
      } else if (tokenHeight > 0) {
        info = {
          type: "hls",
          maxHeight: tokenHeight,
          ladder: [],
          qualitySource: "label",
        };
      } else {
        info = { type: "hls", maxHeight: 0, ladder: [], qualitySource: "unknown" };
      }
    } else if (text && isHlsMediaManifest(text)) {
      // Confirmed single-rendition media playlist; height from URL token if any.
      info = {
        type: "hls",
        maxHeight: tokenHeight > 0 ? tokenHeight : inferHeightFromUrl(entry.url),
        ladder: [],
        qualitySource: tokenHeight > 0 || inferHeightFromUrl(entry.url) > 0 ? "probe" : "unknown",
      };
    } else if (tokenHeight > 0) {
      // Fetch failed / empty body — still apply label/URL tokens; never invent.
      info = {
        type: "hls",
        maxHeight: tokenHeight,
        ladder: [],
        qualitySource: "label",
      };
    } else {
      info = { type: "hls", maxHeight: 0, ladder: [], qualitySource: "unknown" };
    }
  }

  info = withLadderMax(info);
  const known = info.maxHeight > 0 || info.ladder.length > 0;
  qualityCache.set(key, {
    info,
    expiresAt: Date.now() + (known ? QUALITY_CACHE_SUCCESS_TTL_MS : QUALITY_CACHE_FAILURE_TTL_MS),
  });
  return info;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!);
    }
  }

  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

/**
 * Full-scrape only: attach real quality (type/maxHeight/ladder) per source URL.
 * mp4 entries are classified for free (no network). hls/dash entries are bounded
 * to QUALITY_PROBE_MAX_NETWORK fetches at a time, concurrency 5, 3s/fetch, 10s
 * total budget — everything beyond the cap/budget keeps maxHeight 0 (unknown).
 * Cached by URL so re-scrapes of a popular title are free.
 */
export async function probeSourceQuality(
  entries: QualityProbeEntry[]
): Promise<Map<string, QualityInfo>> {
  const out = new Map<string, QualityInfo>();
  if (!entries.length) return out;

  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  const mp4Entries = unique.filter(
    (e) => classifyStreamKind(e.url, e.label, e.quality) === "mp4"
  );
  for (const e of mp4Entries) {
    out.set(e.url, await probeQualityOne(e));
  }

  const networked = unique.filter(
    (e) => classifyStreamKind(e.url, e.label, e.quality) !== "mp4"
  );

  // Cache hits are free — apply them regardless of the network cap below.
  const toFetch: QualityProbeEntry[] = [];
  for (const e of networked) {
    const cached = qualityCache.get(urlCacheKey(e.url));
    if (cached && cached.expiresAt > Date.now()) {
      out.set(e.url, { ...cached.info });
    } else {
      toFetch.push(e);
    }
  }

  const selected = toFetch.slice(0, QUALITY_PROBE_MAX_NETWORK);
  const overflow = toFetch.slice(QUALITY_PROBE_MAX_NETWORK);
  const deadline = Date.now() + QUALITY_PROBE_GLOBAL_BUDGET_MS;

  await mapPool(selected, QUALITY_PROBE_CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) {
      out.set(entry.url, {
        type: classifyStreamKind(entry.url, entry.label, entry.quality),
        maxHeight: 0,
        ladder: [],
        qualitySource: "unknown",
      });
      return;
    }
    out.set(entry.url, await probeQualityOne(entry));
  });

  for (const entry of overflow) {
    out.set(entry.url, {
      type: classifyStreamKind(entry.url, entry.label, entry.quality),
      maxHeight: 0,
      ladder: [],
      qualitySource: "unknown",
    });
  }

  return out;
}
