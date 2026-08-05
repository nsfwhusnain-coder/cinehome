/**
 * What this browser can actually decode.
 *
 * The detection this replaces asked one question and applied the answer to a
 * different one. It probed `hvc1.1.6.L93.B0` — HEVC Main profile, 8-bit,
 * **level 3.1**, which tops out around 720p — and used the result to decide
 * whether 4K HEVC was playable. Real 4K HEVC is Main10 at level 5.0/5.1
 * (`hvc1.2.4.L150.B0`). A browser that decodes 4K Main10 in hardware but
 * declines the 8-bit Main string was told it supported no HEVC at all, and
 * every 4K release silently vanished from its roster. AV1 had the same flaw:
 * `av01.0.05M.08` is level 5, 8-bit, and the answer was applied to 4K 10-bit.
 *
 * Three changes:
 *  1. Probe a MATRIX of strings per codec, at the tiers actually shipped, and
 *     treat any hit as support.
 *  2. Ask both transports — `MediaSource.isTypeSupported` for the MSE/hls.js
 *     path and `canPlayType` for progressive `<video>` — because a browser can
 *     genuinely have one without the other (iOS Safari had no MSE until 17.1
 *     while decoding HEVC natively since iOS 11).
 *  3. Refine asynchronously with `navigator.mediaCapabilities.decodingInfo()`,
 *     which is the only API that answers for a specific resolution and
 *     bitrate, and additionally reports whether decode is hardware-backed.
 *
 * Sync accessors stay sync — they sit inside per-source ranking loops — and are
 * simply upgraded in place once the async probe resolves.
 */

/** 4K decode targets, used for the mediaCapabilities refinement. */
const UHD_WIDTH = 3840;
const UHD_HEIGHT = 2160;
const UHD_FRAMERATE = 24;
/** ~15 Mbps: a typical 4K streaming ladder top rung. */
const UHD_BITRATE = 15_000_000;

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

/**
 * A server render has no `window`, so `probeDecodeSync` correctly answers "no"
 * — but that answer must never be CACHED. These caches are module-level, and a
 * Next.js server process is long-lived, so one server-side call would latch
 * "this machine cannot decode HEVC" for every request the process ever serves
 * afterwards. `buildCoordinatorShadowDecision` calls straight into
 * `isSourcePlayableHere` from the playback route, which is exactly that path:
 * without this guard every shadow decision reports the entire HEVC tier
 * ineligible, and the telemetry meant to inform codec decisions is measuring
 * Node rather than the viewer's browser.
 */
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

export function supportsHevc(): boolean {
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

/**
 * Standalone rather than `extends Navigator`: the DOM lib already declares
 * `mediaCapabilities` as non-optional, so widening it to optional is a genuine
 * conflict. It is optional in reality — older Safari and several TV browsers
 * ship without it — so the guard below is load-bearing, not defensive noise.
 */
interface CapabilityNavigator {
  mediaCapabilities?: {
    decodingInfo(config: unknown): Promise<DecodingInfo>;
  };
}

/**
 * Ask mediaCapabilities whether a specific 4K configuration decodes here.
 * Returns null when the API is absent or the query throws, so callers keep the
 * synchronous answer rather than downgrading on an unsupported browser.
 */
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

/**
 * Upgrade the cached answers with a real 4K query. Safe to call more than once
 * and safe to never call — ranking works from the synchronous probe either way.
 *
 * Deliberately additive: a positive mediaCapabilities result can turn support
 * ON (the string matrix was too conservative) but a negative one never turns it
 * OFF, because a browser that accepts the codec string and plays it in practice
 * must not lose its roster to a stricter secondary opinion.
 */
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

/**
 * True when HEVC is reachable ONLY through the plain <video> element and not
 * through MSE.
 *
 * This is the one case where giving up hls.js is worth it. Native HLS has no
 * JS-level API to select or floor a rendition — AVFoundation and the equivalent
 * TV pipelines run ABR inside the OS with no hook — so choosing it forfeits
 * HLS_MIN_HEIGHT, applyPreferredHlsQuality and the adaptive floor entirely. That
 * price is only worth paying when MSE genuinely cannot decode the codec and the
 * native path is the only one that can.
 *
 * Deliberately measured rather than assumed from the user agent: some TV
 * browsers carry HEVC through MSE perfectly well, and those should keep the
 * quality floor.
 */
export function hevcNeedsNativePath(): boolean {
  return !mseAccepts(HEVC_PROBE_TYPES) && elementAccepts(HEVC_PROBE_TYPES);
}

/** Test seam — capability is cached for the session in normal use. */
export function resetDecodeCapabilityCache(): void {
  hevcCache.value = null;
  av1Cache.value = null;
}
