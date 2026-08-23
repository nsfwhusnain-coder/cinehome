import { isTvUserAgent } from "@/lib/tv-detect";

export const UHD_WIDTH = 3840;
export const UHD_HEIGHT = 2160;
export const UHD_BITRATE = 20_000_000;
export const UHD_FRAMERATE = 24;

/**
 * HEVC strings spanning the tiers actually shipped: Main 8-bit at 720p/1080p
 * levels, Main10 at 4K levels, and the `hev1`/`hvc1` box variants, which some
 * browsers accept asymmetrically.
 */
export const HEVC_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="hvc1.2.4.L153.B0"', // Main10 L5.1 — 4K HDR
  'video/mp4; codecs="hvc1.2.4.L150.B0"', // Main10 L5.0 — 4K
  'video/mp4; codecs="hev1.2.4.L150.B0"',
  'video/mp4; codecs="hvc1.1.6.L123.B0"', // Main L4.1 — 1080p
  'video/mp4; codecs="hvc1.1.6.L93.B0"', // Main L3.1 — the old, narrow probe
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
];

/** AV1 across 8-bit and 10-bit at 4K-capable levels. */
export const AV1_PROBE_TYPES: readonly string[] = [
  'video/mp4; codecs="av01.0.13M.10"', // Main, level 5.1, 10-bit — 4K HDR
  'video/mp4; codecs="av01.0.12M.10"',
  'video/mp4; codecs="av01.0.13M.08"',
  'video/mp4; codecs="av01.0.05M.08"', // the old, narrow probe
  'video/mp4; codecs="av01"',
];

export interface DecodeSupport {
  /** Any transport reports this codec as decodable. */
  supported: boolean;
  /** mediaCapabilities confirmed decode at 4K. Undefined until the async probe lands. */
  uhd?: boolean;
  /** mediaCapabilities reports hardware-backed decode at 4K. */
  hardware?: boolean;
}

const UNSUPPORTED: DecodeSupport = { supported: false };

/** True when MSE accepts any string in the matrix. */
function mseAccepts(types: readonly string[]): boolean {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) {
    return false;
  }
  for (const type of types) {
    try {
      if (MediaSource.isTypeSupported(type)) return true;
    } catch {
      /* a throwing string is a no, not a fatal error */
    }
  }
  return false;
}

/** True when a `<video>` element accepts any string in the matrix. */
function elementAccepts(types: readonly string[]): boolean {
  if (typeof document === "undefined") return false;
  let probe: HTMLVideoElement;
  try {
    probe = document.createElement("video");
  } catch {
    return false;
  }
  for (const type of types) {
    try {
      const answer = probe.canPlayType(type);
      if (answer === "probably" || answer === "maybe") return true;
    } catch {
      /* keep probing the rest of the matrix */
    }
  }
  return false;
}

/** Synchronous best answer: either transport accepting any tier is support. */
export function probeDecodeSync(types: readonly string[]): DecodeSupport {
  if (typeof window === "undefined") return UNSUPPORTED;
  return { supported: mseAccepts(types) || elementAccepts(types) };
}

const hevcCache: { value: DecodeSupport | null } = { value: null };
const av1Cache: { value: DecodeSupport | null } = { value: null };

function cachedProbe(
  cache: { value: DecodeSupport | null },
  types: readonly string[]
): DecodeSupport {
  if (cache.value) return cache.value;
  if (typeof window === "undefined") return UNSUPPORTED;
  cache.value = probeDecodeSync(types);
  return cache.value;
}

export function hevcSupport(): DecodeSupport {
  return cachedProbe(hevcCache, HEVC_PROBE_TYPES);
}

export function av1Support(): DecodeSupport {
  return cachedProbe(av1Cache, AV1_PROBE_TYPES);
}

/**
 * Living-room panels whose codec probes lie. Hisense VIDAA / Chrome 76
 * answers "" for every hvc1 string even though the SoC decodes HEVC in
 * hardware. Inventory (`supportsHevc`) and the engine path
 * (`hevcNeedsNativePath`) must agree, or remuxed 4K HEVC is handed to
 * hls.js+MSE and blacks out.
 */
function isLivingRoomHevcTrust(): boolean {
  if (typeof navigator !== "undefined" && isTvUserAgent(navigator.userAgent || "")) {
    return true;
  }
  return (
    typeof document !== "undefined" &&
    document.documentElement?.getAttribute("data-tv") === "1"
  );
}

export function supportsHevc(): boolean {
  // Trust the panel, not the broken probe — otherwise every 4K HEVC release
  // vanishes from the 85-inch roster.
  if (isLivingRoomHevcTrust()) return true;
  return hevcSupport().supported;
}

export function supportsAv1(): boolean {
  return av1Support().supported;
}

interface DecodingInfo {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
}

interface CapabilityNavigator {
  mediaCapabilities?: {
    decodingInfo(config: unknown): Promise<DecodingInfo>;
  };
}

async function probeUhd(contentType: string): Promise<DecodingInfo | null> {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as unknown as CapabilityNavigator).mediaCapabilities;
  if (!api?.decodingInfo) return null;
  try {
    return await api.decodingInfo({
      type: "media-source",
      video: {
        contentType,
        width: UHD_WIDTH,
        height: UHD_HEIGHT,
        bitrate: UHD_BITRATE,
        framerate: UHD_FRAMERATE,
      },
    });
  } catch {
    return null;
  }
}

export async function warmDecodeCapabilities(): Promise<void> {
  const [hevc, av1] = await Promise.all([
    probeUhd('video/mp4; codecs="hvc1.2.4.L150.B0"'),
    probeUhd('video/mp4; codecs="av01.0.13M.10"'),
  ]);
  if (hevc) {
    hevcCache.value = {
      supported: hevcSupport().supported || hevc.supported,
      uhd: hevc.supported,
      hardware: hevc.powerEfficient,
    };
  }
  if (av1) {
    av1Cache.value = {
      supported: av1Support().supported || av1.supported,
      uhd: av1.supported,
      hardware: av1.powerEfficient,
    };
  }
}

export function hevcNeedsNativePath(): boolean {
  if (mseAccepts(HEVC_PROBE_TYPES)) return false;
  if (elementAccepts(HEVC_PROBE_TYPES)) return true;
  return isLivingRoomHevcTrust();
}

export function resetDecodeCapabilityCache(): void {
  hevcCache.value = null;
  av1Cache.value = null;
}
