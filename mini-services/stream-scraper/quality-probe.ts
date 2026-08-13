/**
 * Real quality capture — full scrape path only (never fast=1, TTFF-critical).
 * Mirrors probe.ts's latency prober in shape/conventions, but pulls the actual
 * rendition ladder / max height out of the manifest instead of timing bytes.
 *
 * Every value here comes from either fetched container metadata (HLS/DASH
 * manifests or an MP4 ISO-BMFF track header) or an unambiguous URL path/name
 * token (/1080/, 1080p, …). Nothing is guessed beyond that — unprobed/failed
 * sources keep maxHeight 0 (unknown, not bad).
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
  /** Provider/capture declaration wins over URL and label inference. */
  type?: StreamKind;
}

export interface QualityProbeOptions {
  /** Ultra requests may verify lower-labelled MP4s for stale provider metadata. */
  preferredHeight?: number;
}

export interface QualityInfo {
  type: StreamKind;
  maxHeight: number;
  ladder: number[];
  qualitySource: QualitySource;
  /**
   * Declared bits/sec of the rendition at `maxHeight`. Two releases can both
   * be 1080p and look nothing alike — a 2 Mbps encode is visibly mushy next to
   * a 10 Mbps one — and height alone cannot express that. Omitted (never 0)
   * when the manifest declares no bitrate, so "unknown" stays distinguishable
   * from "genuinely low", matching how maxHeight treats 0.
   */
  bitrateBps?: number;
}

const QUALITY_PROBE_TIMEOUT_MS = 3_000;
const MP4_PROBE_TIMEOUT_MS = 3_000;
const QUALITY_PROBE_CONCURRENCY = 5;
/** Network-probed sources per scrape. Labelled MP4 entries remain free. */
const QUALITY_PROBE_MAX_NETWORK = 12;
const QUALITY_PROBE_GLOBAL_BUDGET_MS = 10_000;
const QUALITY_CACHE_SUCCESS_TTL_MS = 30 * 60 * 1000;
const QUALITY_CACHE_FAILURE_TTL_MS = 2 * 60 * 1000;
/** Complete manifests are accepted only when they fit inside these hard body caps. */
const HLS_MANIFEST_BYTE_CAP = 512 * 1024;
const DASH_MANIFEST_BYTE_CAP = 512 * 1024;
/** Each MP4 probe reads at most this many bytes from the head and, if needed, the tail. */
const MP4_RANGE_BYTE_CAP = 256 * 1024;
const FOUR_K_HEIGHT = 2160;
const ISO_BOX_HEADER_BYTES = 8;
const ISO_EXTENDED_BOX_HEADER_BYTES = 16;
const ISO_FIXED_POINT_SCALE = 65_536;
const TKHD_VERSION_ZERO_DIMENSION_OFFSET = 76;
const TKHD_VERSION_ONE_DIMENSION_OFFSET = 88;
const MIN_VIDEO_DIMENSION = 16;
const MAX_VIDEO_DIMENSION = 16_384;
const MP4_4K_MIN_WIDTH = 3_000;
const MP4_4K_MIN_HEIGHT = 1_200;
const MP4_1440_MIN_WIDTH = 2_300;
const MP4_1440_MIN_HEIGHT = 1_200;
const MP4_1080_MIN_WIDTH = 1_800;
const MP4_1080_MIN_HEIGHT = 700;
const MP4_720_MIN_WIDTH = 1_200;
const MP4_720_MIN_HEIGHT = 500;
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
  mp4MetadataAttempted?: boolean;
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

/** Declared type is authoritative; otherwise classify cheaply without network. */
export function classifyStreamKind(
  url: string,
  label = "",
  quality = "",
  declaredType?: StreamKind
): StreamKind {
  if (declaredType) return declaredType;
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
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    if (resolution) {
      heights.add(qualityHeightFromDimensions(Number(resolution[1]), Number(resolution[2])));
    }
  }
  return Array.from(heights).sort((a, b) => b - a);
}

/** One EXT-X-STREAM-INF variant: the height it renders and the bits/sec it costs. */
export interface HlsRendition {
  height: number;
  bandwidthBps: number;
}

/**
 * AVERAGE-BANDWIDTH first: the plain BANDWIDTH attribute is a peak ceiling the
 * packager guarantees never to exceed, so it overstates lightly-encoded streams
 * and makes two very different 1080p variants look comparable. The average is
 * what the stream actually sustains.
 *
 * The leading `[:,]` matters — a bare /BANDWIDTH=/ also matches the tail of
 * AVERAGE-BANDWIDTH= and would read the average into the peak slot.
 */
function renditionBandwidth(line: string): number {
  const avg = line.match(/AVERAGE-BANDWIDTH=(\d+)/i);
  if (avg) return Number(avg[1]);
  const peak = line.match(/[:,]\s*BANDWIDTH=(\d+)/i);
  return peak ? Number(peak[1]) : 0;
}

/** Pure — every EXT-X-STREAM-INF variant with both its height and its bitrate. */
export function parseHlsMasterRenditions(manifestText: string): HlsRendition[] {
  const out: HlsRendition[] = [];
  for (const raw of manifestText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const height = resolution
      ? qualityHeightFromDimensions(Number(resolution[1]), Number(resolution[2]))
      : 0;
    const bandwidthBps = renditionBandwidth(line);
    if (height > 0 || bandwidthBps > 0) out.push({ height, bandwidthBps });
  }
  return out;
}

/**
 * Bitrate of the tallest rendition — the rung that decides how the source's
 * advertised quality actually looks. Ties on height take the richer encode.
 * Returns 0 when the tallest rendition declares no usable bitrate.
 */
export function topRenditionBitrate(renditions: readonly HlsRendition[]): number {
  let topHeight = 0;
  for (const rendition of renditions) {
    topHeight = Math.max(topHeight, rendition.height);
  }
  if (topHeight <= 0) return 0;

  let best = 0;
  for (const r of renditions) {
    if (r.height === topHeight) best = Math.max(best, r.bandwidthBps);
  }
  return best;
}

type DashContentKind = "video" | "nonvideo" | "unknown";

function xmlAttribute(attributes: string, name: string): string {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return attributes.match(pattern)?.[1] ?? "";
}

function dashContentKind(attributes: string): DashContentKind {
  const contentType = xmlAttribute(attributes, "contentType").toLowerCase();
  const mimeType = xmlAttribute(attributes, "mimeType").toLowerCase();
  const declared = contentType || mimeType.split("/")[0] || "";
  if (declared === "video") return "video";
  if (["audio", "image", "text"].includes(declared)) return "nonvideo";
  const codecs = xmlAttribute(attributes, "codecs").toLowerCase();
  if (/^(avc|hev|hvc|vp0?9|av01|theora)/.test(codecs)) return "video";
  if (/^(mp4a|aac|opus|vorbis)/.test(codecs)) return "nonvideo";
  return "unknown";
}

function dashNumberAttribute(attributes: string, name: string): number {
  const value = Number(xmlAttribute(attributes, name));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function appendDashRepresentations(
  xml: string,
  adaptationAttributes: string,
  out: HlsRendition[]
): void {
  const adaptationKind = dashContentKind(adaptationAttributes);
  const inheritedWidth = dashNumberAttribute(adaptationAttributes, "width");
  const inheritedHeight = dashNumberAttribute(adaptationAttributes, "height");
  const representation = /<(?:[\w.-]+:)?Representation\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = representation.exec(xml))) {
    const attributes = match[1] ?? "";
    const ownKind = dashContentKind(attributes);
    const kind = ownKind === "unknown" ? adaptationKind : ownKind;
    if (kind === "nonvideo") continue;
    const width = dashNumberAttribute(attributes, "width") || inheritedWidth;
    const rawHeight = dashNumberAttribute(attributes, "height") || inheritedHeight;
    if (rawHeight <= 0) continue;
    const height = qualityHeightFromDimensions(width, rawHeight);
    const bandwidthBps = dashNumberAttribute(attributes, "bandwidth");
    out.push({ height, bandwidthBps });
  }
}

export function parseDashVideoRenditions(mpdText: string): HlsRendition[] {
  const out: HlsRendition[] = [];
  const adaptation = /<(?:[\w.-]+:)?AdaptationSet\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?AdaptationSet\s*>/gi;
  let match: RegExpExecArray | null;
  let foundAdaptation = false;
  while ((match = adaptation.exec(mpdText))) {
    foundAdaptation = true;
    appendDashRepresentations(match[2] ?? "", match[1] ?? "", out);
  }
  if (!foundAdaptation) appendDashRepresentations(mpdText, "", out);
  return out;
}

/** Bitrate paired with the tallest video Representation, never an audio maximum. */
export function parseDashTopBitrate(mpdText: string): number {
  return topRenditionBitrate(parseDashVideoRenditions(mpdText));
}

export function isHlsMasterManifest(text: string): boolean {
  return text.split("\n").some((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
}

export function isHlsMediaManifest(text: string): boolean {
  return text.includes("#EXTINF") || text.includes("#EXT-X-TARGETDURATION");
}

/** Video-only DASH Representation heights, unique and descending. */
export function parseDashLadder(mpdText: string): number[] {
  const heights = new Set<number>();
  for (const rendition of parseDashVideoRenditions(mpdText)) {
    heights.add(rendition.height);
  }
  return Array.from(heights).sort((a, b) => b - a);
}

function isCompleteDashManifest(mpdText: string): boolean {
  const root = /<(?:[\w.-]+:)?MPD\b[^>]*>[\s\S]*<\/(?:[\w.-]+:)?MPD\s*>/i;
  return root.test(mpdText);
}

export interface Mp4Dimensions {
  width: number;
  height: number;
}

interface IsoBoxSpan {
  headerBytes: number;
  size: number;
}

interface Mp4RangeResult {
  bytes: Uint8Array;
  status: number;
  totalBytes: number;
}

interface BoundedBytesResult {
  bytes: Uint8Array;
  complete: boolean;
}

type ByteStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: undefined };

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function isoBoxSpan(bytes: Uint8Array, start: number): IsoBoxSpan | null {
  if (start < 0 || start + ISO_BOX_HEADER_BYTES > bytes.byteLength) return null;
  const size32 = readUint32(bytes, start);
  if (size32 !== 1) {
    const size = size32 === 0 ? bytes.byteLength - start : size32;
    return size >= ISO_BOX_HEADER_BYTES ? { headerBytes: ISO_BOX_HEADER_BYTES, size } : null;
  }
  if (start + ISO_EXTENDED_BOX_HEADER_BYTES > bytes.byteLength) return null;
  const high = readUint32(bytes, start + ISO_BOX_HEADER_BYTES);
  const low = readUint32(bytes, start + ISO_BOX_HEADER_BYTES + 4);
  const size = high * 4_294_967_296 + low;
  return Number.isSafeInteger(size) && size >= ISO_EXTENDED_BOX_HEADER_BYTES
    ? { headerBytes: ISO_EXTENDED_BOX_HEADER_BYTES, size }
    : null;
}

function isTkhdType(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === 0x74 &&
    bytes[offset + 1] === 0x6b &&
    bytes[offset + 2] === 0x68 &&
    bytes[offset + 3] === 0x64
  );
}

function dimensionsFromTkhd(bytes: Uint8Array, typeOffset: number): Mp4Dimensions | null {
  const boxStart = typeOffset - 4;
  const span = isoBoxSpan(bytes, boxStart);
  if (!span) return null;
  const payloadStart = boxStart + span.headerBytes;
  const version = bytes[payloadStart];
  if (version !== 0 && version !== 1) return null;
  const dimensionOffset =
    version === 1 ? TKHD_VERSION_ONE_DIMENSION_OFFSET : TKHD_VERSION_ZERO_DIMENSION_OFFSET;
  const widthOffset = payloadStart + dimensionOffset;
  const fieldEnd = widthOffset + 8;
  if (fieldEnd > bytes.byteLength || fieldEnd > boxStart + span.size) return null;
  const width = Math.round(readUint32(bytes, widthOffset) / ISO_FIXED_POINT_SCALE);
  const height = Math.round(readUint32(bytes, widthOffset + 4) / ISO_FIXED_POINT_SCALE);
  if (width < MIN_VIDEO_DIMENSION || height < MIN_VIDEO_DIMENSION) return null;
  if (width > MAX_VIDEO_DIMENSION || height > MAX_VIDEO_DIMENSION) return null;
  return { width, height };
}

/** Pure ISO-BMFF parser: selects the largest non-zero `tkhd` presentation size. */
export function parseMp4Dimensions(bytes: Uint8Array): Mp4Dimensions | null {
  let best: Mp4Dimensions | null = null;
  for (let offset = 4; offset + 4 <= bytes.byteLength; offset++) {
    if (!isTkhdType(bytes, offset)) continue;
    const dimensions = dimensionsFromTkhd(bytes, offset);
    if (!dimensions) continue;
    if (!best || dimensions.width * dimensions.height > best.width * best.height) {
      best = dimensions;
    }
  }
  return best;
}

function qualityHeightFromDimensions(width: number, height: number): number {
  if (width >= MP4_4K_MIN_WIDTH && height >= MP4_4K_MIN_HEIGHT) return FOUR_K_HEIGHT;
  if (width >= MP4_1440_MIN_WIDTH && height >= MP4_1440_MIN_HEIGHT) return 1440;
  if (width >= MP4_1080_MIN_WIDTH && height >= MP4_1080_MIN_HEIGHT) return 1080;
  if (width >= MP4_720_MIN_WIDTH && height >= MP4_720_MIN_HEIGHT) return 720;
  return height;
}

function joinByteChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ByteStreamReadResult> {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  let rejectAbort: ((reason: DOMException) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(new DOMException("The operation was aborted.", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedBytes(
  response: Response,
  byteCap: number,
  signal: AbortSignal
): Promise<BoundedBytesResult> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), complete: false };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    while (totalBytes < byteCap) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) {
        complete = true;
        break;
      }
      const remaining = byteCap - totalBytes;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value.slice();
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength === totalBytes) complete = true;
  return { bytes: joinByteChunks(chunks, totalBytes), complete };
}

function contentRangeTotal(response: Response): number {
  const match = response.headers.get("content-range")?.match(/\/([0-9]+)$/);
  if (!match) return 0;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

function responseContainsCompleteEntity(
  response: Response,
  bounded: BoundedBytesResult
): boolean {
  if (!bounded.complete) return false;
  if (response.status !== 206) return true;
  const match = response.headers.get("content-range")?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) + 1 >= Number(match[3]);
}

async function fetchMp4Range(
  url: string,
  headers: Record<string, string>,
  range: string,
  signal: AbortSignal
): Promise<Mp4RangeResult | null> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Range", range);
  const response = await fetch(url, {
    headers: requestHeaders,
    signal,
    redirect: "follow",
  });
  if (response.status !== 200 && response.status !== 206) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const bounded = await readBoundedBytes(response, MP4_RANGE_BYTE_CAP, signal);
  return { bytes: bounded.bytes, status: response.status, totalBytes: contentRangeTotal(response) };
}

async function probeMp4Dimensions(
  url: string,
  headers: Record<string, string>
): Promise<Mp4Dimensions | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MP4_PROBE_TIMEOUT_MS);
  try {
    const head = await fetchMp4Range(
      url,
      headers,
      `bytes=0-${MP4_RANGE_BYTE_CAP - 1}`,
      controller.signal
    );
    if (!head) return null;
    const headDimensions = parseMp4Dimensions(head.bytes);
    if (headDimensions || head.status !== 206) return headDimensions;
    if (head.totalBytes > 0 && head.totalBytes <= MP4_RANGE_BYTE_CAP) return null;
    const tailRange = head.totalBytes > 0
      ? `bytes=${head.totalBytes - MP4_RANGE_BYTE_CAP}-${head.totalBytes - 1}`
      : `bytes=-${MP4_RANGE_BYTE_CAP}`;
    const tail = await fetchMp4Range(url, headers, tailRange, controller.signal);
    return tail ? parseMp4Dimensions(tail.bytes) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchManifestText(
  url: string,
  headers: Record<string, string>,
  byteCap: number
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUALITY_PROBE_TIMEOUT_MS);
  try {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Range", `bytes=0-${byteCap - 1}`);
    const res = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
      redirect: "follow",
    });
    if (res.status !== 200 && res.status !== 206) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > byteCap) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const bounded = await readBoundedBytes(res, byteCap, controller.signal);
    if (!responseContainsCompleteEntity(res, bounded)) return null;
    return new TextDecoder().decode(bounded.bytes);
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

function streamKindForEntry(entry: QualityProbeEntry): StreamKind {
  return classifyStreamKind(entry.url, entry.label, entry.quality, entry.type);
}

function shouldProbeMp4Metadata(
  entry: QualityProbeEntry,
  options: QualityProbeOptions
): boolean {
  if (streamKindForEntry(entry) !== "mp4") return false;
  const tokenHeight = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
  if (tokenHeight <= 0) return true;
  return (options.preferredHeight ?? 0) >= FOUR_K_HEIGHT && tokenHeight < FOUR_K_HEIGHT;
}

function isCacheUsable(
  entry: QualityProbeEntry,
  cached: CacheEntry,
  options: QualityProbeOptions
): boolean {
  if (cached.expiresAt <= Date.now()) return false;
  if (cached.info.type !== streamKindForEntry(entry)) return false;
  const tokenHeight = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
  const forcedLabelProbe = shouldProbeMp4Metadata(entry, options) && tokenHeight > 0;
  return (
    !forcedLabelProbe ||
    cached.info.qualitySource === "probe" ||
    cached.mp4MetadataAttempted === true
  );
}

async function probeQualityOne(
  entry: QualityProbeEntry,
  options: QualityProbeOptions
): Promise<QualityInfo> {
  const kind = streamKindForEntry(entry);
  const tokenHeight = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
  const key = urlCacheKey(entry.url);
  const cached = qualityCache.get(key);
  if (cached && isCacheUsable(entry, cached, options)) {
    return { ...cached.info };
  }
  let info: QualityInfo;

  if (kind === "mp4") {
    const dimensions = shouldProbeMp4Metadata(entry, options)
      ? await probeMp4Dimensions(entry.url, buildHeaders(entry.session, entry.url))
      : null;
    const maxHeight = dimensions
      ? qualityHeightFromDimensions(dimensions.width, dimensions.height)
      : tokenHeight;
    info = {
      type: "mp4",
      maxHeight,
      ladder: [],
      qualitySource: dimensions ? "probe" : tokenHeight > 0 ? "label" : "unknown",
    };
  } else if (kind === "dash") {
    const headers = buildHeaders(entry.session, entry.url);
    const text = await fetchManifestText(entry.url, headers, DASH_MANIFEST_BYTE_CAP);
    const completeMpd = text && isCompleteDashManifest(text) ? text : null;
    const ladder = completeMpd ? parseDashLadder(completeMpd) : [];
    const dashBitrate = completeMpd ? parseDashTopBitrate(completeMpd) : 0;
    if (ladder.length > 0) {
      info = {
        type: "dash",
        maxHeight: ladder[0]!,
        ladder,
        qualitySource: "manifest",
        ...(dashBitrate > 0 ? { bitrateBps: dashBitrate } : {}),
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
    const text = await fetchManifestText(entry.url, headers, HLS_MANIFEST_BYTE_CAP);
    if (text && isHlsMasterManifest(text)) {
      const ladder = parseHlsMasterLadder(text);
      const bitrateBps = topRenditionBitrate(parseHlsMasterRenditions(text));
      if (ladder.length > 0) {
        info = {
          type: "hls",
          maxHeight: ladder[0]!,
          ladder,
          qualitySource: "manifest",
          ...(bitrateBps > 0 ? { bitrateBps } : {}),
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
  const mp4MetadataAttempted = kind === "mp4" && shouldProbeMp4Metadata(entry, options);
  const metadataProbeFailed = mp4MetadataAttempted && info.qualitySource !== "probe";
  qualityCache.set(key, {
    info,
    expiresAt:
      Date.now() +
      (known && !metadataProbeFailed
        ? QUALITY_CACHE_SUCCESS_TTL_MS
        : QUALITY_CACHE_FAILURE_TTL_MS),
    ...(mp4MetadataAttempted ? { mp4MetadataAttempted: true } : {}),
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

function interleaveProbeProviders(entries: QualityProbeEntry[]): QualityProbeEntry[] {
  const byProvider = new Map<string, QualityProbeEntry[]>();
  for (const entry of entries) {
    const provider = entry.provider.trim().toLowerCase() || "unknown";
    const bucket = byProvider.get(provider) ?? [];
    bucket.push(entry);
    byProvider.set(provider, bucket);
  }
  const ordered: QualityProbeEntry[] = [];
  while (ordered.length < entries.length) {
    for (const bucket of byProvider.values()) {
      const entry = bucket.shift();
      if (entry) ordered.push(entry);
    }
  }
  return ordered;
}

function prioritizeNetworkProbes(
  entries: QualityProbeEntry[],
  options: QualityProbeOptions
): QualityProbeEntry[] {
  const explicit4k: QualityProbeEntry[] = [];
  const ultraMp4: QualityProbeEntry[] = [];
  const opaque: QualityProbeEntry[] = [];
  const labelled: QualityProbeEntry[] = [];
  for (const entry of entries) {
    const height = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
    if (height >= FOUR_K_HEIGHT) explicit4k.push(entry);
    else if (height > 0 && shouldProbeMp4Metadata(entry, options)) ultraMp4.push(entry);
    else if (height <= 0) opaque.push(entry);
    else labelled.push(entry);
  }
  return [
    ...interleaveProbeProviders(explicit4k),
    ...interleaveProbeProviders(ultraMp4),
    ...interleaveProbeProviders(opaque),
    ...interleaveProbeProviders(labelled),
  ];
}

/**
 * Full-scrape only: attach real quality (type/maxHeight/ladder) per source URL.
 * Labelled MP4 entries are classified for free. Opaque MP4 plus HLS/DASH entries
 * are bounded to QUALITY_PROBE_MAX_NETWORK probes at a time, concurrency 5,
 * 3s/probe, 10s total budget — everything beyond the cap/budget keeps maxHeight
 * 0 (unknown). Cached by URL so re-scrapes of a popular title are free.
 */
export async function probeSourceQuality(
  entries: QualityProbeEntry[],
  options: QualityProbeOptions = {}
): Promise<Map<string, QualityInfo>> {
  const out = new Map<string, QualityInfo>();
  if (!entries.length) return out;

  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  const labelledMp4Entries = unique.filter(
    (e) =>
      streamKindForEntry(e) === "mp4" &&
      inferHeightFromUrl(`${e.url} ${e.label} ${e.quality}`) > 0 &&
      !shouldProbeMp4Metadata(e, options)
  );
  for (const e of labelledMp4Entries) {
    out.set(e.url, await probeQualityOne(e, options));
  }

  const networked = unique.filter(
    (e) => streamKindForEntry(e) !== "mp4" || shouldProbeMp4Metadata(e, options)
  );

  // Cache hits are free — apply them regardless of the network cap below.
  const toFetch: QualityProbeEntry[] = [];
  for (const e of networked) {
    const cached = qualityCache.get(urlCacheKey(e.url));
    if (cached && isCacheUsable(e, cached, options)) {
      out.set(e.url, { ...cached.info });
    } else {
      toFetch.push(e);
    }
  }

  const prioritized = prioritizeNetworkProbes(toFetch, options);
  const selected = prioritized.slice(0, QUALITY_PROBE_MAX_NETWORK);
  const overflow = prioritized.slice(QUALITY_PROBE_MAX_NETWORK);
  const deadline = Date.now() + QUALITY_PROBE_GLOBAL_BUDGET_MS;

  await mapPool(selected, QUALITY_PROBE_CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) {
      out.set(entry.url, {
        type: streamKindForEntry(entry),
        maxHeight: 0,
        ladder: [],
        qualitySource: "unknown",
      });
      return;
    }
    out.set(entry.url, await probeQualityOne(entry, options));
  });

  for (const entry of overflow) {
    out.set(entry.url, {
      type: streamKindForEntry(entry),
      maxHeight: 0,
      ladder: [],
      qualitySource: "unknown",
    });
  }

  return out;
}
