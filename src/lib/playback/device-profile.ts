/**
 * Device-class media profile.
 *
 * Every hls.js buffer constant in video-player.tsx was, by its own comment,
 * "verified/tuned for smoothness on a home connection" — i.e. on a desktop.
 * A living-room TV browser is a different machine: webOS and Tizen tabs get a
 * fraction of desktop Chrome's heap and run on an SoC built for a hardware
 * decode pipeline, not for demuxing in JavaScript. Handing them a 64 MB buffer
 * target plus up to 90s of resident media produces exactly the
 * `bufferStalledError` + collapse-to-480p signature seen in production logs.
 *
 * Detection is deliberately conservative: unknown user agents get the desktop
 * profile, which is the behaviour that shipped before this file existed. Only a
 * positive TV match changes anything.
 */

import { isTvLikeDevice, isTvUserAgent } from "@/lib/tv-detect";

export type DeviceClass = "tv" | "desktop";

export interface MediaBufferProfile {
  /** Steady-state forward buffer target, seconds. */
  maxBufferLengthS: number;
  /** Ceiling hls.js may grow toward under sustained good bandwidth, seconds. */
  maxMaxBufferLengthS: number;
  /** Hard byte cap on buffered media, bounding memory regardless of duration. */
  maxBufferSizeBytes: number;
  /** Retained behind the playhead for instant rewind, seconds. */
  backBufferLengthS: number;
  /** Pre-measurement ABR bandwidth guess, bits/sec. */
  abrInitialEstimateBps: number;
}

/** Desktop values — unchanged from the constants this profile replaced. */
const DESKTOP_PROFILE: MediaBufferProfile = {
  maxBufferLengthS: 30,
  maxMaxBufferLengthS: 60,
  maxBufferSizeBytes: 64_000_000,
  backBufferLengthS: 30,
  abrInitialEstimateBps: 10_000_000,
};

/**
 * TV values. Smaller than desktop so a webOS/VIDAA tab does not OOM, but
 * large enough that a 4K HEVC fragment (~4–8 MB) fits. The previous 16 MB
 * ceiling plus a 5 Mbps ABR guess made hls.js treat 4K as unsustainable, so
 * an 85-inch set only ever locked 1080p even when the ladder had Ultra.
 */
const TV_PROFILE: MediaBufferProfile = {
  maxBufferLengthS: 16,
  maxMaxBufferLengthS: 32,
  maxBufferSizeBytes: 48_000_000,
  backBufferLengthS: 12,
  abrInitialEstimateBps: 12_000_000,
};

/**
 * JS heap ceiling below which a browser gets the TV envelope regardless of user
 * agent. 1.5 GB is comfortably under desktop Chrome (typically ~2-4 GB) and
 * above the constrained tabs this protects, so it catches TV browsers that
 * disguise their UA without ever mis-classifying a laptop.
 */
const CONSTRAINED_HEAP_LIMIT_BYTES = 1_500_000_000;

interface HeapAwarePerformance extends Performance {
  memory?: { jsHeapSizeLimit?: number };
}

/** JS heap ceiling in bytes, or 0 when the browser does not report one. */
export function reportedHeapLimitBytes(): number {
  if (typeof performance === "undefined") return 0;
  const memory = (performance as HeapAwarePerformance).memory;
  const limit = memory?.jsHeapSizeLimit;
  return typeof limit === "number" && limit > 0 ? limit : 0;
}

/**
 * Classify from a user-agent string. Exported separately from `detectDeviceClass`
 * so it stays pure and testable without a DOM.
 */
export function deviceClassFromUserAgent(userAgent: string): DeviceClass {
  return isTvUserAgent(userAgent) ? "tv" : "desktop";
}

/** Cached — device class cannot change mid-session, and callers sit in hot paths. */
let deviceClassCache: DeviceClass | null = null;

export function detectDeviceClass(): DeviceClass {
  if (deviceClassCache !== null) return deviceClassCache;
  if (typeof navigator === "undefined") {
    deviceClassCache = "desktop";
    return deviceClassCache;
  }
  // isTvLikeDevice() carries the query-string override and the input-profile
  // heuristic as well as the user agent, so a Google TV panel reporting plain
  // Chrome now gets the constrained buffer envelope it needs rather than the
  // desktop one it was silently being handed.
  const heap = reportedHeapLimitBytes();
  const constrained = heap > 0 && heap < CONSTRAINED_HEAP_LIMIT_BYTES;
  deviceClassCache = isTvLikeDevice() || constrained ? "tv" : "desktop";
  return deviceClassCache;
}

/** Buffer envelope for a device class. Pure — pass the class in to test it. */
export function bufferProfileFor(deviceClass: DeviceClass): MediaBufferProfile {
  return deviceClass === "tv" ? TV_PROFILE : DESKTOP_PROFILE;
}

/** Buffer envelope for the browser actually running this session. */
export function activeBufferProfile(): MediaBufferProfile {
  return bufferProfileFor(detectDeviceClass());
}

/**
 * Compact platform summary for telemetry. Without this, `player_feedback`
 * records provider/engine/heights and nothing that distinguishes a television
 * session from a laptop one — which is why cross-device playback differences
 * were invisible in production logs.
 */
export interface PlatformSummary {
  deviceClass: DeviceClass;
  uaPlatform: string;
  heapLimitMb?: number;
  cores?: number;
  screenWidth?: number;
}

/** Coarse platform token — never the raw UA, which is long and identifying. */
function uaPlatformToken(userAgent: string): string {
  const match = userAgent.match(
    /(web[o0]s|tizen|hbbtv|netcast|android\s?tv|crkey|smart-?tv)/i
  );
  if (match) return match[1].toLowerCase().replace(/\s+/g, "");
  if (/edg\//i.test(userAgent)) return "edge";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
}

export function platformSummary(): PlatformSummary | undefined {
  if (typeof navigator === "undefined") return undefined;
  const userAgent = navigator.userAgent || "";
  const heap = reportedHeapLimitBytes();
  return {
    deviceClass: detectDeviceClass(),
    uaPlatform: uaPlatformToken(userAgent),
    ...(heap > 0 ? { heapLimitMb: Math.round(heap / 1_048_576) } : {}),
    ...(navigator.hardwareConcurrency
      ? { cores: navigator.hardwareConcurrency }
      : {}),
    ...(typeof screen !== "undefined" && screen.width
      ? { screenWidth: screen.width }
      : {}),
  };
}
