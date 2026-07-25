/**
 * Extract video height from the first bytes of a media segment (TS or MP4/fMP4).
 * Used by the HLS proxy when a single-rendition playlist lacks RESOLUTION=
 * and URL tokens are missing. Failures return 0 — never invent heights.
 *
 * Heuristics only (no full demuxer):
 * - ISO BMFF: scan for `tkhd` box height (fixed 16.16) or `stsd` avc1/hvc1 height
 * - MPEG-TS: scan PES for H.264 SPS (NAL type 7) and decode pic_height_in_map_units
 */

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_RANGE_END = 131_071; // bytes=0-131071 (~128 KiB)

export interface SegmentHeightProbeOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  rangeEnd?: number;
  signal?: AbortSignal;
}

/**
 * Probe a segment URL with Range GET and extract height from the body prefix.
 * Returns 0 on any network/parse failure (caller must fall back to original manifest).
 */
export async function probeSegmentHeight(
  segmentUrl: string,
  options: SegmentHeightProbeOptions = {}
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const rangeEnd = options.rangeEnd ?? DEFAULT_RANGE_END;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onOuterAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return 0;
    }
    options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const headers: Record<string, string> = {
      Range: `bytes=0-${rangeEnd}`,
      Accept: "*/*",
      ...(options.headers ?? {}),
    };
    const res = await fetch(segmentUrl, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok && res.status !== 206) return 0;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 32) return 0;
    return extractHeightFromSegmentPrefix(buf);
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}

/**
 * Pure: extract height from a TS/MP4 prefix. Exported for unit tests.
 */
export function extractHeightFromSegmentPrefix(buf: Uint8Array): number {
  if (buf.byteLength < 32) return 0;

  // MPEG-TS sync byte 0x47 every 188 bytes
  if (buf[0] === 0x47) {
    const h = heightFromMpegTs(buf);
    if (h > 0) return h;
  }

  // fMP4 / MP4 often starts with ftyp / styp / moof / mdat
  const mp4 = heightFromIsoBmff(buf);
  if (mp4 > 0) return mp4;

  // Some CDNs prepend ID3 or junk — scan for ftyp / moov / 0x47 mid-buffer
  const scanned = scanForContainerHeight(buf);
  if (scanned > 0) return scanned;

  return 0;
}

function scanForContainerHeight(buf: Uint8Array): number {
  const limit = Math.min(buf.byteLength - 8, 8_192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && i + 188 < buf.byteLength && buf[i + 188] === 0x47) {
      const h = heightFromMpegTs(buf.subarray(i));
      if (h > 0) return h;
    }
    // box type at i+4
    if (i + 8 < buf.byteLength) {
      const type = String.fromCharCode(buf[i + 4]!, buf[i + 5]!, buf[i + 6]!, buf[i + 7]!);
      if (type === "ftyp" || type === "styp" || type === "moov" || type === "moof") {
        const h = heightFromIsoBmff(buf.subarray(i));
        if (h > 0) return h;
      }
    }
  }
  return 0;
}

/** First media URI from an m3u8 media playlist (skip tags / blanks). */
export function firstMediaSegmentUri(playlistText: string): string | null {
  for (const raw of playlistText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

export function resolvePlaylistUri(baseUrl: string, relativeOrAbsolute: string): string {
  try {
    return new URL(relativeOrAbsolute, baseUrl).href;
  } catch {
    return relativeOrAbsolute;
  }
}

// ─── MPEG-TS / H.264 SPS ─────────────────────────────────────────────────────

function heightFromMpegTs(buf: Uint8Array): number {
  const PACKET = 188;
  for (let off = 0; off + PACKET <= buf.byteLength; off += PACKET) {
    if (buf[off] !== 0x47) {
      // Resync
      let found = -1;
      for (let j = off; j + PACKET <= buf.byteLength; j++) {
        if (buf[j] === 0x47) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      off = found;
      if (off + PACKET > buf.byteLength) break;
    }
    const payloadStart = (buf[off + 1]! & 0x40) !== 0;
    let payloadOff = off + 4;
    const adaptation = (buf[off + 3]! >> 4) & 0x3;
    if (adaptation === 2) continue; // adaptation only
    if (adaptation === 3) {
      const adaptLen = buf[off + 4]!;
      payloadOff = off + 5 + adaptLen;
    }
    if (payloadOff >= off + PACKET) continue;
    if (!payloadStart) continue;

    // PES start code 00 00 01
    if (
      payloadOff + 9 < off + PACKET &&
      buf[payloadOff] === 0x00 &&
      buf[payloadOff + 1] === 0x00 &&
      buf[payloadOff + 2] === 0x01
    ) {
      const streamId = buf[payloadOff + 3]!;
      // video stream ids 0xE0-0xEF
      if (streamId < 0xe0 || streamId > 0xef) continue;
      const pesHeaderDataLen = buf[payloadOff + 8]!;
      const esStart = payloadOff + 9 + pesHeaderDataLen;
      if (esStart >= off + PACKET) continue;
      const es = buf.subarray(esStart, off + PACKET);
      const h = heightFromAvcNalStream(es);
      if (h > 0) return h;
    } else {
      // Continuation / raw ES in payload
      const es = buf.subarray(payloadOff, off + PACKET);
      const h = heightFromAvcNalStream(es);
      if (h > 0) return h;
    }
  }
  return 0;
}

function heightFromAvcNalStream(es: Uint8Array): number {
  // Find start codes 00 00 01 or 00 00 00 01
  let i = 0;
  while (i + 4 < es.byteLength) {
    let sc = 0;
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) sc = 3;
    else if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 0 && es[i + 3] === 1) sc = 4;
    if (!sc) {
      i++;
      continue;
    }
    const nalStart = i + sc;
    const nalType = es[nalStart]! & 0x1f;
    // Find next start
    let nalEnd = es.byteLength;
    for (let j = nalStart + 1; j + 3 < es.byteLength; j++) {
      if (es[j] === 0 && es[j + 1] === 0 && (es[j + 2] === 1 || (es[j + 2] === 0 && es[j + 3] === 1))) {
        nalEnd = j;
        break;
      }
    }
    if (nalType === 7) {
      // SPS
      const h = parseAvcSpsHeight(es.subarray(nalStart + 1, nalEnd));
      if (h > 0) return h;
    }
    i = nalEnd;
  }
  return 0;
}

/**
 * Minimal H.264 SPS parser for pic height (progressive, no field_pic).
 * Based on ITU-T H.264 — only the fields needed for height.
 */
function parseAvcSpsHeight(rbsp: Uint8Array): number {
  try {
    const bits = new BitReader(ebspToRbsp(rbsp));
    bits.readBits(8); // profile_idc
    bits.readBits(8); // constraint + reserved
    bits.readBits(8); // level_idc
    bits.readUE(); // seq_parameter_set_id

    const profileIdc = rbsp[0]!;
    if (
      profileIdc === 100 ||
      profileIdc === 110 ||
      profileIdc === 122 ||
      profileIdc === 244 ||
      profileIdc === 44 ||
      profileIdc === 83 ||
      profileIdc === 86 ||
      profileIdc === 118 ||
      profileIdc === 128 ||
      profileIdc === 138 ||
      profileIdc === 139 ||
      profileIdc === 134 ||
      profileIdc === 135
    ) {
      const chromaFormatIdc = bits.readUE();
      if (chromaFormatIdc === 3) bits.readBits(1); // separate_colour_plane_flag
      bits.readUE(); // bit_depth_luma
      bits.readUE(); // bit_depth_chroma
      bits.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = bits.readBits(1);
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (bits.readBits(1)) {
            // scaling_list — skip approximately
            skipScalingList(bits, i < 6 ? 16 : 64);
          }
        }
      }
    }

    bits.readUE(); // log2_max_frame_num
    const picOrderCntType = bits.readUE();
    if (picOrderCntType === 0) {
      bits.readUE();
    } else if (picOrderCntType === 1) {
      bits.readBits(1);
      bits.readSE();
      bits.readSE();
      const n = bits.readUE();
      for (let i = 0; i < n; i++) bits.readSE();
    }
    bits.readUE(); // max_num_ref_frames
    bits.readBits(1); // gaps_in_frame_num
    bits.readUE(); // pic_width_in_mbs_minus1
    const picHeightInMapUnitsMinus1 = bits.readUE();
    const frameMbsOnlyFlag = bits.readBits(1);
    // height = (pic_height_in_map_units_minus1 + 1) * 16 * (2 - frame_mbs_only_flag)
    const height = (picHeightInMapUnitsMinus1 + 1) * 16 * (2 - frameMbsOnlyFlag);
    if (height >= 144 && height <= 4320) return normalizeLadderHeight(height);
    return 0;
  } catch {
    return 0;
  }
}

function skipScalingList(bits: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const delta = bits.readSE();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function ebspToRbsp(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out.push(0, 0);
      i += 2;
      continue;
    }
    out.push(data[i]!);
  }
  return new Uint8Array(out);
}

class BitReader {
  private byteOffset = 0;
  private bitOffset = 0;
  constructor(private readonly data: Uint8Array) {}

  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.byteOffset >= this.data.length) throw new Error("EOF");
      const bit = (this.data[this.byteOffset]! >> (7 - this.bitOffset)) & 1;
      v = (v << 1) | bit;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.byteOffset++;
      }
    }
    return v;
  }

  readUE(): number {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error("UE overflow");
    }
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  readSE(): number {
    const ue = this.readUE();
    const sign = (ue & 1) === 0 ? -1 : 1;
    return sign * Math.ceil(ue / 2);
  }
}

// ─── ISO BMFF (MP4 / fMP4) ───────────────────────────────────────────────────

function heightFromIsoBmff(buf: Uint8Array): number {
  // Prefer stsd visual sample entry (width/height at fixed offsets)
  const stsd = findBox(buf, "stsd");
  if (stsd) {
    const h = heightFromStsd(stsd);
    if (h > 0) return h;
  }
  // tkhd version 0/1 stores height as 16.16 fixed at end of box
  const tkhd = findBox(buf, "tkhd");
  if (tkhd) {
    const h = heightFromTkhd(tkhd);
    if (h > 0) return h;
  }
  // Scan for avc1 / hvc1 / mp4v fourcc
  for (let i = 0; i + 40 < buf.byteLength; i++) {
    const fourcc = String.fromCharCode(buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!);
    if (fourcc === "avc1" || fourcc === "hvc1" || fourcc === "hev1" || fourcc === "mp4v" || fourcc === "av01") {
      // VisualSampleEntry: width @ +24, height @ +26 from start of sample entry
      // Sample entry starts 8 bytes before fourcc (size+type)… actually fourcc IS type at offset 4 of entry.
      // Entry layout: size(4) type(4) reserved(6) data_ref(2) pre_defined… width at +24 from entry start = fourcc-4+24
      const entryStart = i - 4;
      if (entryStart < 0) continue;
      if (entryStart + 28 >= buf.byteLength) continue;
      const height = (buf[entryStart + 26]! << 8) | buf[entryStart + 27]!;
      if (height >= 144 && height <= 4320) return normalizeLadderHeight(height);
    }
  }
  return 0;
}

function heightFromStsd(box: Uint8Array): number {
  // stsd: version/flags(4) entry_count(4) then sample entries
  if (box.byteLength < 16) return 0;
  const entryCount = readU32(box, 4);
  let off = 8;
  for (let e = 0; e < entryCount && off + 8 <= box.byteLength; e++) {
    const size = readU32(box, off);
    if (size < 32 || off + size > box.byteLength) break;
    const height = (box[off + 32]! << 8) | box[off + 33]!;
    // VisualSampleEntry: width @ +24+8? size(4)+type(4)+reserved(6)+data_ref(2)+pre(16) → width at 32, height at 34 from entry
    // ISO 14496-12: after 8-byte header, 6 reserved, 2 data_ref, then 16 bytes pre_defined/reserved, then width u16, height u16
    // offsets from entry start: width=32, height=34
    const h2 = (box[off + 34]! << 8) | box[off + 35]!;
    const candidates = [height, h2];
    for (const h of candidates) {
      if (h >= 144 && h <= 4320) return normalizeLadderHeight(h);
    }
    off += size;
  }
  return 0;
}

function heightFromTkhd(box: Uint8Array): number {
  if (box.byteLength < 5) return 0;
  const version = box[0]!;
  // version 0: height at offset 84 (as 16.16); version 1: at 96
  const heightOff = version === 1 ? 96 : 84;
  if (box.byteLength < heightOff + 4) return 0;
  const fixed = readU32(box, heightOff);
  const height = fixed >> 16;
  if (height >= 144 && height <= 4320) return normalizeLadderHeight(height);
  return 0;
}

function findBox(buf: Uint8Array, type: string): Uint8Array | null {
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    let size = readU32(buf, off);
    const boxType = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    let header = 8;
    if (size === 1 && off + 16 <= buf.byteLength) {
      // largesize — skip if too big for our buffer
      size = Number(readU64(buf, off + 8));
      header = 16;
    }
    if (size < header || off + size > buf.byteLength) {
      // Corrupt or truncated — scan forward a bit
      off += 1;
      continue;
    }
    if (boxType === type) {
      return buf.subarray(off + header, off + size);
    }
    // Containers to recurse
    if (boxType === "moov" || boxType === "trak" || boxType === "mdia" || boxType === "minf" || boxType === "stbl" || boxType === "moof" || boxType === "traf") {
      const inner = findBox(buf.subarray(off + header, off + size), type);
      if (inner) return inner;
    }
    off += size === 0 ? buf.byteLength : size;
  }
  return null;
}

function readU32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0
  );
}

function readU64(buf: Uint8Array, off: number): bigint {
  const hi = BigInt(readU32(buf, off));
  const lo = BigInt(readU32(buf, off + 4));
  return (hi << BigInt(32)) | lo;
}

/** Snap near-standard heights to ladder values (cropping / SAR noise). */
export function normalizeLadderHeight(height: number): number {
  const ladder = [2160, 1440, 1080, 720, 480, 360, 240];
  for (const step of ladder) {
    if (Math.abs(height - step) <= 8) return step;
  }
  return height;
}

/**
 * Build a one-rung master playlist that points at a media playlist URI.
 * Used so hls.js exposes a real height level instead of "Auto only".
 */
export function wrapMediaPlaylistAsMaster(
  mediaPlaylistUri: string,
  height: number,
  bandwidth = 5_000_000
): string {
  const h = height > 0 ? height : 1080;
  const width = Math.round((h * 16) / 9);
  return [
    "#EXTM3U",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${Math.floor(bandwidth * 0.85)},RESOLUTION=${width}x${h}`,
    mediaPlaylistUri,
    "",
  ].join("\n");
}

/**
 * True when the upstream URL looks like a child of a multi-variant master
 * (Vixsrc `type=video&rendition=1080p`, Luna-style `/720/index.m3u8`, etc.).
 * Those must be served as pure media playlists — never re-wrapped as masters
 * (nested wrap causes hls.js to thrash the non-media=1 level URL).
 */
export function looksLikeMultiVariantChildUrl(upstreamUrl: string): boolean {
  let path = "";
  let search = "";
  try {
    const u = new URL(upstreamUrl);
    path = u.pathname;
    search = u.search;
  } catch {
    const q = upstreamUrl.indexOf("?");
    path = q >= 0 ? upstreamUrl.slice(0, q) : upstreamUrl;
    search = q >= 0 ? upstreamUrl.slice(q) : "";
  }
  const pathLower = path.toLowerCase();
  const searchLower = search.toLowerCase();

  // Query: rendition=1080p (often with type=video)
  if (/(?:^|[?&])rendition=/.test(searchLower)) return true;

  // Akamai/Apple-style: /index-s720p.m3u8, /index-s1080p
  if (/\/index-s\d+p(?:[./?]|$)/i.test(pathLower)) return true;

  // Quality folder under a playlist tree: .../720/index.m3u8, .../1080p/playlist.m3u8
  if (/\/(?:2160|1440|1080|720|480|360)p?\//i.test(pathLower)) return true;

  return false;
}

/**
 * Whether a pure media playlist should be wrapped as a 1-rung synthetic master.
 * - skipMediaWrap (media=1 child): never
 * - multi-variant child URL: never (parent master already labeled levels)
 * - pure-media root (no variant signals): yes — quality menu needs RESOLUTION
 */
export function shouldWrapPureMedia(upstreamUrl: string, skipMediaWrap: boolean): boolean {
  if (skipMediaWrap) return false;
  if (looksLikeMultiVariantChildUrl(upstreamUrl)) return false;
  return true;
}

export function isPureHlsMediaPlaylist(text: string): boolean {
  const hasInf = text.includes("#EXTINF") || text.includes("#EXT-X-TARGETDURATION");
  if (!hasInf) return false;
  return !text.split("\n").some((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
}

export function isHlsMasterPlaylist(text: string): boolean {
  return text.split("\n").some((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
}
