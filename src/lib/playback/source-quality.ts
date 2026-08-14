import type { PlaybackSource, SourceProbeMetrics } from "./types";
import { supportsAv1, supportsHevc } from "./decode-capability";
import { DEFAULT_SOURCE_KEY } from "@/lib/player-preferences";
import {
  isNeverAutoDefaultUrl,
  isPoisonStreamUrl,
  POISON_SCORE_PENALTY,
} from "./poison-url";
import {
  containerFromDirectUrl,
  isBrowserPlayableContainer,
  type ReleaseContainer,
} from "./debrid/torrentio";
import { unwrapProxyUpstream } from "./source-identity";

/**
 * Live-transcode target cap (task: transcode-target policy). 4K live
 * transcoding on the owner's single shared VAAPI encoder is slow-starting
 * (~0.9x realtime — see mini-services/transcoder/index.ts) so anything
 * routed through /api/transcode is capped to this height regardless of the
 * source's real ceiling: a 4K source that must be RE-ENCODED becomes a
 * smooth, universal 1080p H.264 ABR ladder that starts reasonably fast.
 *
 * Scope note: this cap applies to re-encoding only. It does NOT apply to the
 * remux route (`sourceDelivery` -> "remux"), which is a stream copy — no
 * decoder, no encoder, so there is nothing to be slow and nothing to gain by
 * downscaling. That is why a 4K MKV now plays at its real 4K where it
 * previously could only ever arrive at this cap. Shared with video-player.tsx
 * so the actual encode height and the badge/UI claim can never drift apart.
 */
export const TRANSCODE_MAX_HEIGHT = 1080;

const RESOLUTION_PATTERNS = [
  /\b2160p\b/i,
  /\b4k\b/i,
  /\b1440p\b/i,
  /\b1080p\b/i,
  /\b720p\b/i,
  /\b480p\b/i,
  /\b360p\b/i,
];

/** Owner's absolute base quality — a source meeting this must never lose the
 * auto-default to one that doesn't, regardless of probe/verified/format tier. */
export const HD_FLOOR_HEIGHT = 1080;

/** Minimum evidence before a rolling success rate changes auto-selection. */
export const RUNTIME_HEALTH_MIN_SAMPLES = 5;
/** Below this rate a provider is skipped while another playable source exists. */
export const RUNTIME_HEALTH_MIN_SUCCESS_RATE = 0.5;
/** A mature provider at or above this rate counts as positively healthy. */
const RUNTIME_HEALTH_GOOD_SUCCESS_RATE = 0.75;
/** Ignore tiny rate differences that would make otherwise-equal sources churn. */
const RUNTIME_HEALTH_RATE_DEADBAND = 0.15;

/**
 * Settings preferred quality → ranking / discovery target height.
 * `"auto"` hunts 4K when a playable UHD source exists, then richest 1080p.
 * The 1080p floor is still enforced by ranking tiers — Auto never prefers
 * known sub-HD over known HD.
 */
export function resolvePreferredHeightTarget(
  pref: "auto" | number | null | undefined
): number {
  if (pref == null || pref === "auto") return 2160;
  return pref;
}

/** True when source metadata (maxHeight / ladder / label) claims ≥ target. */
export function sourceMeetsHeight(
  source: PlaybackSource,
  targetHeight: number
): boolean {
  return sourceMaxHeight(source) >= targetHeight;
}

/**
 * IDs present in `current` but not yet seen in `previous`.
 * Used for the non-blocking "New source available" nudge (Change 3).
 */
export function findNewSourceIds(
  previousIds: ReadonlySet<string> | Iterable<string>,
  current: ReadonlyArray<{ id: string }>
): string[] {
  const prev =
    previousIds instanceof Set ? previousIds : new Set(previousIds);
  const out: string[] = [];
  for (const s of current) {
    if (!prev.has(s.id)) out.push(s.id);
  }
  return out;
}

/**
 * Post-play quality upgrade (Change 12): only when **confirmed** decode height
 * is below the HD floor AND another non-failed source has **known** ≥floor
 * metadata. Never upgrades on unknown (0) height. Caller must also gate on
 * auto-selected source + once-per-session.
 */
export function findQualityUpgradeSource(
  current: PlaybackSource,
  sources: PlaybackSource[],
  confirmedPlayingHeight: number,
  failedIds: ReadonlySet<string> | ReadonlyArray<string> = [],
  options?: {
    preferredProvider?: string | null;
    preferredHeight?: "auto" | number | null;
    hdFloor?: number;
  }
): PlaybackSource | null {
  const floor = options?.hdFloor ?? HD_FLOOR_HEIGHT;
  // Unknown (0) or already meeting floor → no upgrade.
  if (confirmedPlayingHeight <= 0 || confirmedPlayingHeight >= floor) {
    return null;
  }

  const failed =
    failedIds instanceof Set ? failedIds : new Set(failedIds);

  const candidates = sources.filter(
    (s) =>
      s.id !== current.id &&
      !failed.has(s.id) &&
      sourceMaxHeight(s) >= floor &&
      // Never auto-upgrade to a release this browser can't decode (task 2).
      isSourcePlayableHere(s)
  );
  if (!candidates.length) return null;

  return pickDefaultSource(
    candidates,
    options?.preferredProvider,
    options?.preferredHeight
  );
}

/**
 * Merge a confirmed decode height into source metadata for badge honesty
 * (Change 10 — MP4 / native single-rendition). Never invents a multi-rung
 * ladder; multi-rendition adaptive sources keep their probed max/ladder
 * (playing height is not the source ceiling).
 */
export function withDetectedSourceHeight(
  source: PlaybackSource,
  detectedHeight: number
): PlaybackSource {
  if (detectedHeight <= 0) return source;
  if (isMultiRendition(source)) return source;
  if ((source.maxHeight ?? 0) === detectedHeight) return source;
  return { ...source, maxHeight: detectedHeight };
}

/**
 * Merge a client-measured background health probe into a source that has no
 * server-side probe yet (Server-list honesty — bounded background probing).
 * Never overwrites a probe the server already measured: the full-scrape
 * latency probe is authoritative real-CDN data; the client-side reachability
 * check only fills the gap so the Server list's health dot is never a
 * permanent "unknown" for a source the server never got around to probing.
 */
export function withClientHealthProbe(
  source: PlaybackSource,
  probe: SourceProbeMetrics
): PlaybackSource {
  if (source.probe != null) return source;
  return { ...source, probe };
}

/** Coarse latency → speedScore band for the client-side background health
 * probe (same 0-100 scale as the server's measured `speedScore`). Latency
 * thresholds are deliberately generous — this measures browser-observed
 * round trip to a proxied/CDN URL over a home connection, not a datacenter
 * link, so it should not out-penalize a merely-average connection. */
export function speedScoreFromLatencyMs(ttfbMs: number): number {
  if (ttfbMs <= 150) return 95;
  if (ttfbMs <= 400) return 80;
  if (ttfbMs <= 900) return 60;
  if (ttfbMs <= 2000) return 40;
  return 20;
}

export type SourceHealthState = "healthy" | "checking" | "weak";

export function isRuntimeSourceUnhealthy(
  source: PlaybackSource,
  now = Date.now()
): boolean {
  const health = source.runtimeHealth;
  if (!health) return false;
  if (health.cooldownUntil != null && health.cooldownUntil > now) return true;
  return (
    health.sampleCount >= RUNTIME_HEALTH_MIN_SAMPLES &&
    health.successRate < RUNTIME_HEALTH_MIN_SUCCESS_RATE
  );
}

function hasGoodRuntimeHealth(source: PlaybackSource): boolean {
  const health = source.runtimeHealth;
  return Boolean(
    health &&
      health.sampleCount >= RUNTIME_HEALTH_MIN_SAMPLES &&
      health.successRate >= RUNTIME_HEALTH_GOOD_SUCCESS_RATE
  );
}

/** Array.sort comparator: negative means `a` has stronger runtime evidence. */
function compareRuntimeHealth(
  a: PlaybackSource,
  b: PlaybackSource
): number {
  const aUnhealthy = isRuntimeSourceUnhealthy(a) ? 1 : 0;
  const bUnhealthy = isRuntimeSourceUnhealthy(b) ? 1 : 0;
  if (aUnhealthy !== bUnhealthy) return aUnhealthy - bUnhealthy;

  const aHealth = a.runtimeHealth;
  const bHealth = b.runtimeHealth;
  if (
    !aHealth ||
    !bHealth ||
    aHealth.sampleCount < RUNTIME_HEALTH_MIN_SAMPLES ||
    bHealth.sampleCount < RUNTIME_HEALTH_MIN_SAMPLES
  ) {
    return 0;
  }
  const rateDelta = bHealth.successRate - aHealth.successRate;
  return Math.abs(rateDelta) >= RUNTIME_HEALTH_RATE_DEADBAND ? rateDelta : 0;
}

/**
 * Non-active health classification for the Server list's dot indicator.
 * "checking" = no probe yet — unproven, but never disproven either, so it
 * renders neutrally rather than as broken (matches `autoPlayPool`'s "unknown
 * ranks above known sub-HD" honesty rule elsewhere in this file).
 * "weak" = soft-kept (failed segment verify), a probe that came back
 * unhealthy, or a hard runtime failure this session (`forceWeak`) — visibly
 * marked and sorted last by `sortSourcesForPicker`, but still manually
 * selectable (never silently hidden, just never auto-picked).
 */
export function sourceHealthState(
  source: PlaybackSource,
  forceWeak = false
): SourceHealthState {
  if (forceWeak) return "weak";
  if (isRuntimeSourceUnhealthy(source)) return "weak";
  if (source.verified === false) return "weak";
  if (source.probe?.ok === false) return "weak";
  if (source.probe?.ok === true) return "healthy";
  if (hasGoodRuntimeHealth(source)) return "healthy";
  return "checking";
}

export function parseMaxHeight(text: string): number {
  const lower = text.toLowerCase();
  if (/\b2160p\b|\b4k\b/.test(lower)) return 2160;
  if (/\b1440p\b/.test(lower)) return 1440;
  if (/\b1080p\b/.test(lower)) return 1080;
  if (/\b720p\b/.test(lower)) return 720;
  if (/\b480p\b/.test(lower)) return 480;
  if (/\b360p\b/.test(lower)) return 360;
  const resMatch = text.match(/(\d{3,4})p/i);
  if (resMatch) return Number(resMatch[1]);
  const dimMatch = text.match(/RESOLUTION=\d+x(\d+)/i);
  if (dimMatch) return Number(dimMatch[1]);
  // Path/query tokens like /1080/ or _720_ (no trailing "p") — same contract as
  // scraper inferHeightFromUrl. Never invent beyond an unambiguous delimiter token.
  const pathToken = lower.match(
    /[\/_-](2160|1440|1080|720|480|360)p?(?:[\/_.?&-]|$)/
  );
  if (pathToken) return Number(pathToken[1]);
  return 0;
}

/**
 * Best-known height for ranking/UI. Order:
 * ladder[0] → maxHeight if >0 → quality tokens → label/provider/url tokens.
 * maxHeight ≤0 is treated as missing (probed-unknown), so quality/url tokens
 * still apply. Returns 0 only when nothing is known — never invents height.
 */
export function sourceMaxHeight(source: PlaybackSource): number {
  if (source.ladder && source.ladder.length > 0 && source.ladder[0]! > 0) {
    return source.ladder[0]!;
  }
  if (source.maxHeight != null && source.maxHeight > 0) {
    return source.maxHeight;
  }
  const fromQuality = parseMaxHeight(source.quality);
  if (fromQuality > 0) return fromQuality;
  return parseMaxHeight(`${source.label} ${source.provider} ${source.url}`);
}

/** True when the source carries a real probed adaptive ladder with more than one rung. */
export function isMultiRendition(source: PlaybackSource): boolean {
  return (source.ladder?.length ?? 0) > 1;
}

export function formatResolutionLabel(height: number): string {
  if (height >= 2160) return "4K";
  if (height > 0) return `${height}p`;
  return "Auto";
}

/**
 * Convert decoded raster dimensions to the familiar 16:9 quality tier.
 *
 * Cropped cinema encodes commonly decode at 1920×800/816/960 while still
 * carrying the full horizontal detail of a 1080p release. Treating the raw
 * height as 800/816/960 falsely triggered a post-play "HD upgrade" and tore
 * down healthy 1920-wide playback for label-only sources that could decode
 * as low as 720×360. Width establishes the nominal tier for landscape
 * video; portrait video uses its shorter horizontal edge.
 */
export function decodedQualityHeight(width: number, height: number): number {
  if (height <= 0) return 0;
  if (width <= 0) return height;
  if (height > width) return width;

  const widthTier =
    width >= 3_800
      ? 2160
      : width >= 2_500
        ? 1440
        : width >= 1_900
          ? 1080
          : width >= 1_260
            ? 720
            : width >= 840
              ? 480
              : width >= 630
                ? 360
                : 0;
  return Math.max(height, widthTier);
}

/** Badge the source's real advertised height. Decode-incompatible releases
 * remain visible but are explicitly marked unavailable; the UI must not
 * invent a lower resolution for a transcode path that production disables. */
function baseQualityBadge(source: PlaybackSource): string {
  const h = sourceMaxHeight(source);
  if (h >= 2160) return "4K";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h > 0) return `${h}p`;
  if (source.type === "hls") return "Adaptive";
  return source.quality !== "auto" ? source.quality : "Auto";
}

/** Short, honest marker for a source this browser cannot DECODE. Container
 * problems no longer earn this tag — those are remuxed and play normally — so
 * it now means what it says: no route exists, in this browser, at all. */
const UNAVAILABLE_BADGE_TAG = "unavailable";

export function qualityBadge(source: PlaybackSource): string {
  const badge = baseQualityBadge(source);
  // A release this browser cannot decode says so before it is clicked.
  const withCompatTag = isSourcePlayableHere(source)
    ? badge
    : `${badge} · ${UNAVAILABLE_BADGE_TAG}`;
  if (source.origin !== "debrid") return withCompatTag;
  // Distinguish the TorBox sibling tier from Real-Debrid in the UI — both
  // still get the same debrid ranking bonus/transcode penalty (origin-based).
  const tag = source.provider === "TorBox" ? "TorBox" : "Debrid";
  return `${withCompatTag} (${tag})`;
}

function isHevcSource(source: PlaybackSource): boolean {
  if (source.codec === "hevc") return true;
  if (source.codec === "h264") return false;
  const url = source.url.toLowerCase();
  return url.includes("h265") || url.includes("hevc") || url.includes("hev1");
}

/**
 * Deliberately NOT cached here.
 *
 * This used to hold its own `boolean | null` on the grounds that capability
 * cannot change mid-session. It can. `warmDecodeCapabilities()` asks
 * mediaCapabilities whether 4K HEVC really decodes and upgrades
 * decode-capability's cache when the string matrix was too conservative — and
 * it runs from the player (video-player.tsx), which is AFTER the roster has
 * already been ranked and badged. So the first, pre-warm answer got latched
 * here for the whole session and the correction never reached the UI: the
 * roster kept reporting "HEVC is not supported by this browser" on a browser
 * that had just been measured decoding it.
 *
 * There is no cost to dropping it. `supportsHevc()` is itself cached inside
 * decode-capability.ts, so the hot ranking path still resolves this to one
 * object read per call — it just reads the value that can still be corrected.
 */

/**
 * Real HEVC decode capability for THIS browser, covering BOTH playback paths
 * that matter here:
 *  - MSE-buffered (hls.js/dash.js adaptive ladders) — `MediaSource.isTypeSupported`.
 *  - Plain `<video>` progressive playback — the path RD's direct MP4 sources
 *    actually use, checked via `canPlayType`. This is NOT the same capability
 *    as MSE: iOS Safari had no MediaSource support at all until iOS 17.1,
 *    while its `<video>` tag has decoded HEVC natively (hardware) since iOS
 *    11 — an MSE-only check would wrongly report every pre-17.1 iOS Safari as
 *    HEVC-incapable and tank the Safari-only debrid bonus for its real
 *    audience. Either signal being true is enough.
 */
function browserSupportsHevc(): boolean {
  // Delegates to decode-capability.ts, which probes a MATRIX of HEVC strings
  // across the tiers actually shipped. The single string this used to test
  // (`hvc1.1.6.L93.B0`) is Main 8-bit at level 3.1 — roughly 720p — and its
  // answer was being applied to 4K Main10, which is a different capability.
  return supportsHevc();
}

/**
 * Real AV1 decode capability for THIS browser. AV1-in-MP4 has the OPPOSITE
 * browser affinity from HEVC: Chrome/Firefox decode it natively (software or
 * hardware depending on device), while older Safari does not reliably
 * support AV1 at all (`compat` alone can't express this — a release can be
 * `compat:"native"` for the HEVC/HDR/MKV sense and still be AV1, which is a
 * completely independent decode requirement). Checked the same way as HEVC:
 * MSE `isTypeSupported` OR a `<video>` element's `canPlayType` for the
 * actual progressive-MP4 path RD's direct sources use.
 */
function browserSupportsAv1(): boolean {
  // Same correction as HEVC: `av01.0.05M.08` is level 5, 8-bit, and its answer
  // was applied to 4K 10-bit HDR releases. Uncached here for the same reason —
  // warmDecodeCapabilities() can still upgrade this answer.
  return supportsAv1();
}

/**
 * How this source can be delivered to THIS browser.
 *
 * - "direct"      container and codec are both fine; attach the URL as-is.
 * - "remux"       the CONTAINER is the only problem. MKV/WebM open in no
 *                 browser, Safari included, but a large share of them hold
 *                 streams the browser decodes natively — AV1 and H.264 video,
 *                 Opus/AAC audio. Rewrapping to fMP4 is a stream copy (no
 *                 decode, no encode; measured 60s of 4K AV1 in 6s wall), so
 *                 these are genuinely playable rather than dead inventory.
 * - "unavailable" the CODEC cannot be decoded here. No container change helps:
 *                 Chrome cannot decode HEVC in any wrapper, ever.
 */
export type SourceDelivery = "direct" | "remux" | "unavailable";

function codecDecodableHere(source: PlaybackSource): boolean {
  if (source.codec === "av1") return browserSupportsAv1();
  if (source.codec === "hevc") return browserSupportsHevc();
  if (source.codec === "h264") return true;
  // Unknown codec: fall back to the release-level compat hint. Note MKV forces
  // that hint to "safari", so an unknown-codec MKV stays conservative here
  // rather than being optimistically surfaced and failing on first frame.
  return source.compat !== "safari" || browserSupportsHevc();
}

/**
 * Audio is an independent delivery constraint. A browser accepting the video
 * codec says nothing about E-AC-3/DTS/TrueHD, and progressive multi-audio MP4
 * selection is not exposed consistently enough to enforce the user's language
 * choice. In either case the existing remux worker can copy video untouched
 * while producing one selected AAC track.
 */
function resolvedSourceContainer(source: PlaybackSource): ReleaseContainer | undefined {
  const fromUrl = containerFromDirectUrl(unwrapProxyUpstream(source.url));
  if (fromUrl) return fromUrl;
  return source.container;
}

function audioCodecDecodableHere(source: PlaybackSource): boolean {
  const codec = source.audioCodec;
  if (!codec || codec === "unknown" || codec === "aac" || codec === "mp3") {
    return true;
  }
  if (codec === "dts" || codec === "truehd" || codec === "flac") return false;
  // AC-3 / E-AC-3 / Opus in MP4: play the file. Remuxing a 4K progressive
  // just in case the browser dislikes the audio is why Poseidon sat on
  // "Repackaging" while Pan (same height, direct MP4) started immediately.
  const container = resolvedSourceContainer(source);
  const containerOk = !container || isBrowserPlayableContainer(container);
  if (containerOk && (codec === "ac3" || codec === "eac3" || codec === "opus")) {
    return true;
  }
  if (typeof document === "undefined") return false;
  try {
    const media = document.createElement("audio");
    const mime =
      codec === "eac3"
        ? 'audio/mp4; codecs="ec-3"'
        : codec === "ac3"
          ? 'audio/mp4; codecs="ac-3"'
          : 'audio/mp4; codecs="opus"';
    const support = media.canPlayType(mime);
    return support === "probably" || support === "maybe";
  } catch {
    return false;
  }
}

function audioNeedsRemux(source: PlaybackSource): boolean {
  return !audioCodecDecodableHere(source);
}

export function sourceDelivery(source: PlaybackSource): SourceDelivery {
  if (!codecDecodableHere(source)) return "unavailable";
  const container = resolvedSourceContainer(source);
  const containerOk = !container || isBrowserPlayableContainer(container);
  // HLS/DASH playlists are already browser-legal. Packing them is the
  // "Repackaging" stall. An MKV still remuxes even if someone labelled it HLS.
  if ((source.type === "hls" || source.type === "dash") && containerOk) {
    return "direct";
  }
  return containerOk && !audioNeedsRemux(source) ? "direct" : "remux";
}

/**
 * Can this source reach the screen at all, by any route?
 *
 * Deliberately true for "remux": the container is not a dead end any more, so
 * everything that gates *inventory* (auto-play pool, unavailable badge, health
 * evidence) should let those through. Callers that care about the COST of the
 * route — ranking, mid-playback upgrades — must ask `sourceDelivery` instead,
 * because a remux still spends server bandwidth and a couple of seconds of
 * startup that a direct URL does not.
 */
export function isSourcePlayableHere(source: PlaybackSource): boolean {
  return sourceDelivery(source) !== "unavailable";
}

/**
 * When the user picks a remux-only debrid row, switch to a same-height
 * progressive sibling instead of waiting on the packer.
 */
export function findDirectDebridAlternative(
  source: PlaybackSource,
  roster: readonly PlaybackSource[]
): PlaybackSource | null {
  if (source.origin !== "debrid" || sourceDelivery(source) !== "remux") {
    return null;
  }
  const height = sourceMaxHeight(source);
  const direct = roster.filter(
    (row) =>
      row.origin === "debrid" &&
      row.id !== source.id &&
      sourceDelivery(row) === "direct"
  );
  return (
    direct.find((row) => sourceMaxHeight(row) >= height && height > 0) ??
    direct.find((row) => sourceMaxHeight(row) >= HD_FLOOR_HEIGHT) ??
    direct[0] ??
    null
  );
}

/**
 * Human-readable reason for inventory that exists but cannot be decoded on
 * this device. Keeping the release visible is important: otherwise the same
 * server response appears to contain 4K in Safari/webOS and no 4K in Chrome,
 * when the real difference is only the browser's codec support.
 */
export function sourceUnavailableReason(source: PlaybackSource): string | null {
  if (isSourcePlayableHere(source)) return null;
  if (source.codec === "hevc" || isHevcSource(source)) {
    return "HEVC is not supported by this browser";
  }
  if (source.codec === "av1") {
    return "AV1 is not supported by this browser";
  }
  return "This video codec is not supported by this browser";
}

/**
 * Order between two delivery routes, as a comparator fragment
 * (negative = `a` first, 0 = no opinion).
 *
 * Two rules, and the second is the whole reason this exists:
 *
 *  1. "unavailable" always sinks. Nothing about it is playable.
 *  2. "direct" beats "remux" ONLY when it costs no resolution. A remux is a
 *     stream copy, so a 4K MKV remuxes to 4K — capping it behind a 1080p
 *     direct source would throw away the resolution the user actually has,
 *     which is exactly the bug this delivery split was built to fix. At equal
 *     height the direct route wins, since the rewrap buys nothing there.
 */
function compareDelivery(
  a: PlaybackSource,
  b: PlaybackSource,
  aHeight: number,
  bHeight: number
): number {
  const aDel = sourceDelivery(a);
  const bDel = sourceDelivery(b);
  if (aDel === bDel) return 0;
  if (aDel === "unavailable") return 1;
  if (bDel === "unavailable") return -1;
  if (aDel === "direct" && aHeight >= bHeight) return -1;
  if (bDel === "direct" && bHeight >= aHeight) return 1;
  return 0;
}

function hevcPenalty(): number {
  return browserSupportsHevc() ? 0 : 40;
}

/** Picker / dock label: "Aether · 1080p HLS" */
export function formatSourcePickerLabel(source: PlaybackSource): string {
  const name = source.label?.trim() || source.provider || "Source";
  const badge = qualityBadge(source);
  const type =
    source.type === "dash" ? "DASH" : source.type === "mp4" ? "MP4" : "HLS";
  return `${name} · ${badge} ${type}`;
}

function isHlsSource(source: PlaybackSource): boolean {
  if (source.type === "hls") return true;
  return source.url.toLowerCase().includes(".m3u8");
}

function isDashSource(source: PlaybackSource): boolean {
  if (source.type === "dash") return true;
  return source.url.toLowerCase().includes(".mpd");
}

function isProgressiveMp4(source: PlaybackSource): boolean {
  if (isHlsSource(source) || isDashSource(source)) return false;
  if (source.type === "mp4") return true;
  return source.url.toLowerCase().includes(".mp4");
}

function isSolsticeSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  return p.includes("vidking") || l.startsWith("solstice");
}

/** Native Videasy API (Cypher/Yoru) plus CinePro's Quasar sub-provider. */
function isQuasarSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  return p.includes("videasy") || l === "quasar" || l.startsWith("quasar ");
}

/** CinePro multi-provider streams (Lordflix-class proxy path). */
function isCineproSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  return (
    p.includes("cinepro") ||
    l.startsWith("aether") ||
    l.startsWith("horizon") ||
    l.startsWith("nest") ||
    l.startsWith("zephyr")
  );
}

function isPulseSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  return p.includes("notorrent") || l.startsWith("pulse");
}

function isPhoenixSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  // Lordflix also ships a server named Phoenix — provider wins.
  if (p.includes("lordflix") || p.includes("videasy")) return false;
  return p.includes("vidlink") || l.startsWith("phoenix");
}

/** Strong bonus so a 4K/1080p debrid source outranks embed 1080p — but never enough to beat the transcode-required penalty below. */
const DEBRID_BASE_BONUS = 150;
/** Large enough that an undecodable (HEVC/AV1-incapable) debrid source drops below a plain natively-playable 1080p source — it cannot be played at all, so it must never win a tie. */
const DEBRID_TRANSCODE_PENALTY = 220;
/**
 * Remux tax. Small ON PURPOSE, and the size is load-bearing: it must be big
 * enough to lose an equal-height tie to a direct source, and smaller than the
 * 30-point gap between the 4K (120) and 1080p (90) height bands, so a 4K MKV
 * still outscores a 1080p direct file. A stream copy costs some server
 * bandwidth and ~2s of startup — not a resolution tier.
 */
const DEBRID_REMUX_PENALTY = 25;

/**
 * Bits/sec needed to match H.264's picture at the same height. Modern codecs
 * hit the same quality on far less, so raw bitrate systematically flatters
 * H.264 and would make every efficient encode look like the worse release.
 * Comparing `bitrate * efficiency` puts them on one scale.
 *
 * Conservative on purpose: HEVC's headline claim is ~50% of H.264 and AV1's is
 * better still, but those are best-case encoder figures. Under-crediting a
 * modern codec costs a marginally wrong tie-break; over-crediting it promotes a
 * genuinely thinner encode over a fatter one.
 */
const CODEC_BITRATE_EFFICIENCY: Record<string, number> = {
  h264: 1,
  hevc: 1.6,
  av1: 1.8,
};
/** Unknown codec is assumed H.264 — the common embed case, and never inflates. */
const DEFAULT_CODEC_EFFICIENCY = 1;
/** Startup bandwidth must exceed the declared stream rate by this safety margin. */
const BITRATE_STARTUP_HEADROOM_RATIO = 1.25;
/** Avoid tearing down a cold start for tiny manifest-rate changes. */
const BITRATE_RICHNESS_SWITCH_RATIO = 1.25;
/**
 * Minimum H.264-equivalent rate that justifies replacing a cold source whose
 * own rate is unknown. This prevents any merely-declared bitrate from causing
 * a restart while still allowing a clearly rich encode to win before frame 1.
 */
const UNKNOWN_RATE_SWITCH_FLOOR_BPS: ReadonlyArray<readonly [number, number]> = [
  [2160, 15_000_000],
  [1440, 9_000_000],
  [1080, 6_000_000],
  [720, 3_000_000],
  [480, 1_500_000],
  [0, 750_000],
];
/**
 * Score contribution ceiling for the bitrate term. Must stay under the 30-point
 * gap between the 4K (120) and 1080p (90) height bands, so a fat 1080p encode
 * can never score its way past a genuine 4K source. Bitrate breaks ties inside
 * a resolution tier; it does not create one.
 */
const BITRATE_SCORE_MAX = 20;
/** Bits/sec that earns the full `BITRATE_SCORE_MAX` — ~12 Mbps is a strong 1080p remux. */
const BITRATE_SCORE_SATURATION_BPS = 12_000_000;

/**
 * Manifest-declared bitrate normalized to an H.264-equivalent, or 0 when the
 * source declares none. 0 means unknown and must never be read as "low".
 */
export function normalizedBitrate(source: PlaybackSource): number {
  const declared = source.bitrateBps ?? 0;
  if (declared <= 0) return 0;
  const efficiency =
    CODEC_BITRATE_EFFICIENCY[source.codec ?? ""] ?? DEFAULT_CODEC_EFFICIENCY;
  return declared * efficiency;
}

/**
 * Tie-break for two sources of the SAME height: the richer encode wins.
 *
 * Sources with declared rates rank ahead of unknown rates at equal height,
 * then richer known rates rank first. Presence must be an explicit rank: an
 * unknown value cannot tie every known value while known values are ordered
 * without creating comparator cycles and arrival-order-dependent defaults.
 *
 * Callers must have already established equal height — bitrate across
 * different resolutions is meaningless (4K at 8 Mbps beats 1080p at 10).
 */
export function compareBitrateAtEqualHeight(
  a: PlaybackSource,
  b: PlaybackSource
): number {
  return compareNormalizedBitrates(normalizedBitrate(a), normalizedBitrate(b));
}

function compareNormalizedBitrates(aRate: number, bRate: number): number {
  const aKnown = aRate > 0 ? 1 : 0;
  const bKnown = bRate > 0 ? 1 : 0;
  if (aKnown !== bKnown) return bKnown - aKnown;
  if (!aKnown) return 0;
  return bRate - aRate;
}

function sourceTopMatchesTarget(
  source: PlaybackSource,
  targetHeight: number
): boolean {
  const topHeight = sourceMaxHeight(source);
  const tolerance = Math.max(40, targetHeight * 0.12);
  return Math.abs(topHeight - targetHeight) <= tolerance;
}

function normalizedBitrateForTarget(
  source: PlaybackSource,
  targetHeight: number | null
): number {
  if (targetHeight == null || !sourceOffersTarget(source, targetHeight)) {
    return normalizedBitrate(source);
  }
  // bitrateBps is the top rendition's rate. It says nothing about a lower
  // selected rung in a taller ladder unless per-rung metadata is available.
  return sourceTopMatchesTarget(source, targetHeight)
    ? normalizedBitrate(source)
    : 0;
}

function unknownRateSwitchFloor(height: number): number {
  return (
    UNKNOWN_RATE_SWITCH_FLOOR_BPS.find(([minimum]) => height >= minimum)?.[1] ??
    UNKNOWN_RATE_SWITCH_FLOOR_BPS.at(-1)![1]
  );
}

/** -1 = measured link cannot sustain the encode, 0 = unknown, 1 = enough headroom. */
export function bitrateSustainabilityRank(source: PlaybackSource): -1 | 0 | 1 {
  const bitrate = source.bitrateBps ?? 0;
  const throughput = source.probe?.bytesPerSec ?? 0;
  if (bitrate <= 0 || source.probe?.ok !== true || throughput <= 0) return 0;
  // bitrateBps describes the top rendition. A multi-rung source can start on
  // a lower safe rung and retain its 4K upside, so top-rate shortfall is not a
  // source-wide failure without per-rung bitrate metadata.
  if (isMultiRendition(source)) return 0;
  return throughput * 8 >= bitrate * BITRATE_STARTUP_HEADROOM_RATIO ? 1 : -1;
}

function compareBitrateSustainability(
  a: PlaybackSource,
  b: PlaybackSource
): number {
  return bitrateSustainabilityRank(b) - bitrateSustainabilityRank(a);
}

function compareInsufficientBitrate(a: PlaybackSource, b: PlaybackSource): number {
  const aInsufficient = bitrateSustainabilityRank(a) < 0 ? 1 : 0;
  const bInsufficient = bitrateSustainabilityRank(b) < 0 ? 1 : 0;
  return aInsufficient - bInsufficient;
}

/** True only when `candidate` is a meaningfully richer encode at the same resolution. */
export function isMeaningfullyRicherSource(
  current: PlaybackSource,
  candidate: PlaybackSource
): boolean {
  const height = sourceMaxHeight(current);
  if (height !== sourceMaxHeight(candidate)) return false;
  const currentRate = normalizedBitrate(current);
  const candidateRate = normalizedBitrate(candidate);
  const clearsRichnessThreshold =
    currentRate > 0
      ? candidateRate >= currentRate * BITRATE_RICHNESS_SWITCH_RATIO
      : candidateRate >= unknownRateSwitchFloor(height);
  return (
    candidateRate > 0 &&
    clearsRichnessThreshold &&
    bitrateSustainabilityRank(candidate) >= 0
  );
}

/** Bounded score contribution — richer encode scores higher inside its tier. */
function bitrateScoreBonus(source: PlaybackSource): number {
  const rate = normalizedBitrate(source);
  if (rate <= 0) return 0;
  const ratio = Math.min(1, rate / BITRATE_SCORE_SATURATION_BPS);
  return Math.round(ratio * BITRATE_SCORE_MAX);
}

/**
 * PREMIUM debrid tier adjustment, scaled by how the source has to be delivered
 * (`sourceDelivery`): full bonus for a direct URL, a light tax for a stream
 * copy, and a penalty that wipes the bonus out for anything this browser
 * genuinely cannot decode.
 */
function debridScoreAdjustment(source: PlaybackSource): number {
  if (source.origin !== "debrid") return 0;
  const delivery = sourceDelivery(source);
  const tax =
    delivery === "unavailable"
      ? DEBRID_TRANSCODE_PENALTY
      : delivery === "remux"
        ? DEBRID_REMUX_PENALTY
        : 0;
  return DEBRID_BASE_BONUS - tax;
}

export function scoreSource(source: PlaybackSource): number {
  const pref = typeof window !== "undefined" ? localStorage.getItem("cinehome:preferred-provider") : null;
  const prefBonus = pref && matchesPreference(source, pref) ? 200 : 0;
  const debridAdj = debridScoreAdjustment(source);
  const poisonTax = isPoisonStreamUrl(source.url) ? POISON_SCORE_PENALTY : 0;

  const hevc = isHevcSource(source);
  const hevcTax = hevc ? hevcPenalty() : 0;

  // Measured latency probe is primary when available (no name-based CDN bonus).
  if (source.probe?.ok) {
    let score = source.probe.speedScore * 10;
    score -= hevcTax;
    score -= poisonTax;
    score += bitrateScoreBonus(source);
    if (isDashSource(source) && hevc) score -= hevcTax > 0 ? 20 : 0;
    return score + prefBonus + debridAdj;
  }

  let score = 0;
  const h = sourceMaxHeight(source);
  if (h >= 2160) score += 120;
  else if (h >= 1080) score += 90;
  else if (h >= 720) score += 60;
  else if (h > 0) score += 30;
  // Real multi-rendition adaptive ladder beats a single-rendition source at the same height.
  if (isMultiRendition(source)) score += 15;
  // Encode richness inside the height band — capped below the band gap so it
  // can never promote a 1080p past a 4K (see BITRATE_SCORE_MAX).
  score += bitrateScoreBonus(source);

  const hls = isHlsSource(source);
  const dash = isDashSource(source);

  // Prefer .m3u8 H264 HLS; demote progressive MP4; soft-penalize HEVC only if unsupported.
  if (hls && !hevc) score += 80;
  else if (hls) score += 40;
  else if (dash && !hevc) score += 40;
  else if (dash) score += 15;
  else if (isProgressiveMp4(source)) score += 10;
  else score += 10;

  score -= hevcTax;
  score -= poisonTax;
  if (dash && hevc && hevcTax > 0) score -= 20;

  // Home-proxy reliability (Solstice single-hop wins over CinePro double-hop).
  if (isSolsticeSource(source)) score += 50;
  else if (isCineproSource(source) && !isLunaSource(source)) score += 30;
  else if (isPulseSource(source)) score += 5;
  else if (isLunaSource(source)) score += 10;

  return score + prefBonus + debridAdj;
}

/**
 * Source picker: playable/healthy first, then resolution and encode richness,
 * then the saved server and adaptive-ladder conveniences. The visible order
 * mirrors auto-pick: 4K stays above HD, while a meaningfully richer 1080p
 * encode is not hidden below a leaner one merely because the latter arrived
 * from an adaptive manifest.
 */
export function sortSourcesForPicker(sources: PlaybackSource[]): PlaybackSource[] {
  const pref =
    typeof window !== "undefined" ? localStorage.getItem("cinehome:preferred-provider") : null;
  return [...sources].sort((a, b) => {
    // Honesty (Server list, req 4): a release this browser can't decode sinks
    // to the bottom — still listed, since inventory is real, but never above
    // something that plays. Same rule the auto-pick uses, so the list's top
    // row and the source that actually starts agree.
    const deliveryOrder = compareDelivery(a, b, sourceMaxHeight(a), sourceMaxHeight(b));
    if (deliveryOrder !== 0) return deliveryOrder;

    const aVer = a.verified === false ? 0 : 1;
    const bVer = b.verified === false ? 0 : 1;
    if (aVer !== bVer) return bVer - aVer;

    // Same normalization as pickDefaultSource (see hasHealthEvidence): an
    // unprobed-but-validated debrid source is healthy, not unknown, so the
    // visible order in the Servers panel matches what auto-pick actually does.
    // An explicitly FAILED probe still sorts below unknown.
    const aOk = a.probe?.ok === false ? -1 : hasHealthEvidence(a) ? 1 : 0;
    const bOk = b.probe?.ok === false ? -1 : hasHealthEvidence(b) ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;

    // Runtime health only reorders within the same viable evidence tier. A
    // cooldown must not promote a soft-kept or probe-dead row above it.
    const runtimeOrder = compareRuntimeHealth(a, b);
    if (runtimeOrder !== 0) return runtimeOrder;

    const insufficientOrder = compareInsufficientBitrate(a, b);
    if (insufficientOrder !== 0) return insufficientOrder;

    const aH = sourceMaxHeight(a);
    const bH = sourceMaxHeight(b);
    if (aH !== bH) return bH - aH;

    const supportOrder = compareBitrateSustainability(a, b);
    if (supportOrder !== 0) return supportOrder;

    const bitrateOrder = compareBitrateAtEqualHeight(a, b);
    if (bitrateOrder !== 0) return bitrateOrder;

    const aMatch = pref && matchesPreference(a, pref) ? 1 : 0;
    const bMatch = pref && matchesPreference(b, pref) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;

    const aMulti = isMultiRendition(a) ? 1 : 0;
    const bMulti = isMultiRendition(b) ? 1 : 0;
    if (aMulti !== bMulti) return bMulti - aMulti;

    const nameA = `${a.provider} ${a.label}`.toLowerCase();
    const nameB = `${b.provider} ${b.label}`.toLowerCase();
    const nameOrder = nameA.localeCompare(nameB);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}

function matchesPreference(source: PlaybackSource, pref: string): boolean {
  const lower = pref.trim().toLowerCase();
  if (!lower) return false;
  const key = `${source.provider}|${source.label}`.toLowerCase();
  if (key === lower || key.includes(lower)) return true;
  if (source.provider.toLowerCase().includes(lower)) return true;
  if (source.label.toLowerCase().includes(lower)) return true;
  if (source.id.toLowerCase().includes(lower.replace(/\s+/g, "-"))) return true;
  return false;
}

export function preferenceKey(source: PlaybackSource): string {
  const serverLabel = source.label.trim();
  const generic = ["hls", "dash", "mp4", "stream", "auto", "luna"];
  if (serverLabel && !generic.includes(serverLabel.toLowerCase())) {
    return `${source.provider}|${serverLabel}`;
  }
  return source.provider;
}

function isLunaSource(source: PlaybackSource): boolean {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  // Lordflix also ships a server named Luna — only Vixsrc is the slow CDN we rank mid-tier.
  if (p.includes("lordflix") || p.includes("videasy")) return false;
  return p === "vixsrc" || p.includes("vixsrc") || l === "luna";
}

/** Slow CDN class: Vixsrc/Luna (~3s/seg). Auto-upgrade target when faster sources arrive. */
export function isSlowCdnSource(source: PlaybackSource): boolean {
  if (source.probe != null) return source.probe.ok && source.probe.speedScore < 35;
  return isLunaSource(source);
}

/** Fast CDN class: Vidking/Solstice or NoTorrent/Pulse. */
export function isFastCdnSource(source: PlaybackSource): boolean {
  if (source.probe?.ok) return source.probe.speedScore >= 50;
  return (
    isCineproSource(source) ||
    isSolsticeSource(source) ||
    isPulseSource(source)
  );
}

/**
 * True when `candidate` is a strict CDN upgrade from `current`.
 * Uses measured probe scores when present; else Luna → Solstice/Pulse name heuristic.
 */
export function isFasterSource(current: PlaybackSource, candidate: PlaybackSource): boolean {
  if (current.id === candidate.id) return false;
  // "direct", not merely playable: this fires MID-PLAYBACK, and interrupting a
  // stream that is already running to start a server-side rewrap is not an
  // upgrade the viewer asked for. A remux only ever gets chosen up front, by
  // pickDefaultSource, where its resolution gain is weighed openly.
  if (
    candidate.origin === "debrid" &&
    current.origin !== "debrid" &&
    sourceDelivery(candidate) === "direct"
  ) {
    return true;
  }
  if (candidate.probe?.ok && current.probe?.ok) {
    return candidate.probe.speedScore >= current.probe.speedScore + 10;
  }
  if (candidate.probe?.ok && !current.probe?.ok) return true;
  return isSlowCdnSource(current) && isFastCdnSource(candidate);
}

/**
 * Failover priority (higher = preferred when quality similar):
 * Solstice → Pulse → Luna → Phoenix (H264 HLS only) → Nova → Orion → …
 * Phoenix HEVC/DASH heavily demoted. Luna stays playable but never default over Solstice.
 */
/**
 * Household home-proxy rank (higher = better default).
 * Solstice first: direct CDN + known referer overrides, single hop.
 * CinePro second: only when segment-verified (probe.ok).
 * Luna last among good options: slow residential double-hop.
 */
function sourceFailoverPriority(source: PlaybackSource): number {
  const p = source.provider.toLowerCase();
  const l = source.label.toLowerCase();
  // Premium direct-play debrid is already media-validated server-side and
  // avoids the residential HLS proxy hop. Keep it ahead of embed-provider
  // name heuristics; incompatible debrid rows never reach the autoplay pool.
  if (source.origin === "debrid" && isSourcePlayableHere(source)) return 110;
  // Best free fallback: direct CDN + known referer overrides, single hop.
  if (isSolsticeSource(source)) return 100;
  // Native Videasy/Quasar 1080 MP4 ladder — above Luna, below Solstice.
  if (isQuasarSource(source) && !isHevcSource(source)) return 82;
  // Share/Fshare progressive rungs — often probe-soft-fail; never auto-default over HLS CDNs.
  if (l.startsWith("share") || p.includes("fshare")) {
    if (l.includes("1080")) return 25;
    if (l.includes("720")) return 18;
    return 12;
  }
  // #2 CinePro Aether/Horizon (not Luna) when not HEVC
  if (isCineproSource(source) && !isLunaSource(source) && !isHevcSource(source)) {
    if (l.startsWith("aether")) return 90;
    if (l.startsWith("horizon")) return 85;
    if (l.startsWith("nest")) return 75; // VidNest often carries anime/TV
    return 80;
  }
  // Pulse PHP — effectively hide from default
  if (isPulseSource(source)) {
    const u = source.url.toLowerCase();
    if (u.includes(".php") || u.includes("hostingersite.com")) return 1;
    if (isHlsSource(source) && !isHevcSource(source)) return 22;
    return 5;
  }
  if (
    (p.includes("vidrock") || l === "rock" || l.startsWith("rock ")) &&
    !isHevcSource(source)
  ) {
    if (isHlsSource(source)) return 78;
    return 70;
  }
  if (p.includes("cinemaos") || l === "cinema" || l.startsWith("cinema ")) {
    return sourceMaxHeight(source) >= 1080 ? 76 : 60;
  }
  if (isLunaSource(source)) return 50;
  if (isPhoenixSource(source)) {
    if (isHevcSource(source) || isDashSource(source)) return 2;
    // Phoenix H264 often works for anime when Solstice misses — above Pulse, below Luna.
    if (isHlsSource(source) && !isHevcSource(source)) return 48;
    if (isProgressiveMp4(source) && !isHevcSource(source)) return 20;
    return 5;
  }
  if (p.includes("embed.su") || l.startsWith("nova")) return 55;
  if (p.includes("vidsrc") || l.startsWith("orion") || l.startsWith("vienna") || l.startsWith("lion") || l.startsWith("sakura")) return 42;
  if (p.includes("vidnest") || l.startsWith("nest")) return 70;
  if (p.includes("vidfast") || l.startsWith("flux")) return 5;
  if (p.includes("vidjoy") || l.startsWith("joy")) return 4;
  if (p.includes("2embed") || l.startsWith("astra")) return 4;
  if (p.includes("multiembed") || l.startsWith("blaze")) return 3;
  if (p.includes("smashy") || l.startsWith("comet")) return 2;
  // HEVC-only Videasy leftovers. Non-HEVC Quasar already scored 82 above.
  if (p.includes("lordflix")) return 1;
  if (p.includes("embed")) return 6;
  return 0;
}

function isSoftKept(source: PlaybackSource): boolean {
  return source.verified === false;
}

/**
 * Auto-play pool: trust filter only — NEVER filter by resolution.
 * HD preference is ranking weight in pickDefaultSource, not a hard gate.
 * Fallback order for ranking (not exclusion): ≥1080 known → unknown → <1080.
 * Poison / junk URLs never enter the auto-default pool when any clean source exists.
 */
function autoPlayPool(sources: PlaybackSource[]): PlaybackSource[] {
  const hevcOk = browserSupportsHevc();
  const browserPlayable = sources.filter(isSourcePlayableHere);
  const viable = browserPlayable.filter(
    (source) =>
      source.probe?.ok !== false &&
      !isSoftKept(source) &&
      (!isHevcSource(source) || hevcOk)
  );
  const runtimeEligible = viable.filter(
    (source) => !isRuntimeSourceUnhealthy(source)
  );
  // Health only reorders within the viable tier. It must never promote a
  // probe-dead or soft-kept URL above a cooling-down verified source.
  const notHardDead = runtimeEligible.length ? runtimeEligible : viable;
  if (!notHardDead.length) {
    // Keep failed/soft sources as manual auto-recovery fallbacks. Undecodable
    // ones are already gone (browserPlayable); remuxable ones stay, since the
    // rewrap path is production-enabled.
    const soft = browserPlayable.filter((s) => s.probe?.ok !== false);
    const runtimeSoft = soft.filter(
      (source) => !isRuntimeSourceUnhealthy(source)
    );
    const softPool = runtimeSoft.length ? runtimeSoft : soft;
    // Prefer non-poison even among soft fallbacks.
    const softClean = softPool.filter((s) => !isNeverAutoDefaultUrl(s.url));
    if (softClean.length) return softClean;
    return softPool.length ? softPool : browserPlayable;
  }

  // Strip poison when any non-poison playable source exists.
  const noPoison = notHardDead.filter((s) => !isNeverAutoDefaultUrl(s.url));
  const pool = noPoison.length ? noPoison : notHardDead;

  const probeOk = pool.filter((s) => s.probe?.ok === true);
  if (probeOk.some((s) => sourceMaxHeight(s) >= HD_FLOOR_HEIGHT)) {
    // Prefer probed HD, but still keep untested HD + unknowns in the pool
    // so ranking can choose them and the roster is not silently thinned.
    const extras = pool.filter((s) => !probeOk.includes(s));
    return [...probeOk, ...extras];
  }

  // No confirmed HD yet — entire clean pool (includes unknowns + 720p).
  // pickDefaultSource ranks ≥1080 first, then multi-rung, then unknowns above sub-HD.
  return pool;
}

/**
 * The default-pick sort's top tier was originally "HLS beats everything else"
 * (adaptive ladder reliability). A natively-playable debrid source (Chrome-
 * safe H.264/MP4, or HEVC/AV1 the current browser can decode — never
 * MKV/WebM, see `isSourcePlayableHere`) is a genuine PREMIUM upgrade —
 * progressive but CDN-direct and already decode-safe — so it belongs in that
 * same top tier; real resolution then decides the winner within it. A
 * debrid source this browser cannot DECODE never qualifies here (autoPlayPool
 * already excludes it from the auto-default pool entirely in that case,
 * though it stays visible in the picker, badged unavailable).
 */
function isTopTierSource(source: PlaybackSource): boolean {
  if (isHlsSource(source)) return true;
  return source.origin === "debrid" && isSourcePlayableHere(source);
}

/**
 * Health evidence for ranking, normalized across the two tiers.
 *
 * The latency prober (`probeSourceBatch`) lives in the stream-scraper and only
 * ever measures scraper sources. The debrid tier is resolved separately in the
 * Next app and merged in afterward (see mergeDebridSources), so a debrid source
 * ALWAYS has `probe === undefined` — not "unhealthy", just never eligible for
 * that particular measurement.
 *
 * Ranking used to compare `probe?.ok` directly, which quietly made that
 * structural gap decisive: because the probe test sits above `isTopTierSource`
 * and far above `scoreSource`'s DEBRID_BASE_BONUS, any embed the scraper had
 * probed beat every equal-height debrid source outright. Observed live on
 * Fight Club: a Luna embed with `probe.ok=true, speedScore=16` (the file's own
 * `isSlowCdnSource` treats <35 as slow) won the auto-pick over three healthy
 * Real-Debrid 1080p direct-CDN sources.
 *
 * A natively-playable debrid source is not unproven. It cleared a stricter
 * server-side gate than the latency probe: a Range plausibility probe plus, for
 * unknown containers, an ISO-BMFF signature check (see media-validation.ts) —
 * both of which must pass before it can become a PlaybackSource at all. So it
 * ranks as healthy here rather than as missing data. This asserts nothing new;
 * it stops discarding validation that already happened.
 */
function hasHealthEvidence(source: PlaybackSource): boolean {
  if (source.probe?.ok === true) return true;
  if (hasGoodRuntimeHealth(source)) return true;
  return source.origin === "debrid" && isSourcePlayableHere(source);
}

function sourceOffersTarget(source: PlaybackSource, targetHeight: number): boolean {
  const heights = source.ladder?.length
    ? source.ladder
    : [sourceMaxHeight(source)];
  const tolerance = Math.max(40, targetHeight * 0.12);
  return heights.some((height) => Math.abs(height - targetHeight) <= tolerance);
}

/** Highest confirmed resolution across the whole roster (0 = nothing known yet). */
export function sourceRosterMaxHeight(sources: PlaybackSource[]): number {
  return sources.reduce((max, s) => Math.max(max, sourceMaxHeight(s)), 0);
}

/**
 * True when at least one source in the roster genuinely offers >=1080p.
 * Used to gate the auto-default (task 5: never silently default to a
 * sub-1080 source when an HD one exists) and the honest "1080p isn't
 * available for this title" notice (task 6) when none do.
 */
export function sourceRosterMeetsHdFloor(sources: PlaybackSource[]): boolean {
  return sourceRosterMaxHeight(sources) >= HD_FLOOR_HEIGHT;
}

export function pickDefaultSource(
  sources: PlaybackSource[],
  preferredProvider?: string | null,
  /** Settings preferred quality height (`"auto"` hunts 4K after health). */
  preferredHeight?: "auto" | number | null
): PlaybackSource | null {
  if (!sources.length) return null;
  const pickPool = autoPlayPool(sources);

  // A stored server is a late tie-break, not an early return. This preserves
  // the viewer's preference when quality evidence is tied or unknown, but a
  // lean saved 1080p source must not suppress a meaningfully richer 1080p
  // encode (and can never override an available Ultra target).
  const pref = (preferredProvider || DEFAULT_SOURCE_KEY || "").trim();

  // Ranking only — never filters the pool empty.
  // Poison gate first, then height tiers, multi-rung / probe / prio.
  const sorted = [...pickPool].sort((a, b) => {
    const aPoison = isPoisonStreamUrl(a.url) ? 1 : 0;
    const bPoison = isPoisonStreamUrl(b.url) ? 1 : 0;
    if (aPoison !== bPoison) return aPoison - bPoison;

    const aH = sourceMaxHeight(a) || 0;
    const bH = sourceMaxHeight(b) || 0;
    const insufficientOrder = compareInsufficientBitrate(a, b);
    if (insufficientOrder !== 0) return insufficientOrder;

    const explicitTarget =
      typeof preferredHeight === "number" ? preferredHeight : null;
    let aOffersTarget = false;
    let bOffersTarget = false;
    if (explicitTarget != null) {
      aOffersTarget = sourceOffersTarget(a, explicitTarget);
      bOffersTarget = sourceOffersTarget(b, explicitTarget);
      const aTarget = aOffersTarget ? 1 : 0;
      const bTarget = bOffersTarget ? 1 : 0;
      if (aTarget !== bTarget) return bTarget - aTarget;
    }
    const aRankH = aOffersTarget ? explicitTarget! : aH;
    const bRankH = bOffersTarget ? explicitTarget! : bH;
    const heightTier = (h: number): number => {
      if (h >= HD_FLOOR_HEIGHT) return 3;
      if (h >= 720) return 2;
      if (h <= 0) return 1; // unknown — still above confirmed 480/360
      return 0;
    };
    const aTier = heightTier(aRankH);
    const bTier = heightTier(bRankH);
    if (aTier !== bTier) return bTier - aTier;

    const runtimeOrder = compareRuntimeHealth(a, b);
    if (runtimeOrder !== 0) return runtimeOrder;

    const aOk = hasHealthEvidence(a) ? 1 : 0;
    const bOk = hasHealthEvidence(b) ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;

    const aVer = a.verified === false ? 0 : 1;
    const bVer = b.verified === false ? 0 : 1;
    if (aVer !== bVer) return bVer - aVer;

    if (aTier !== 1 && aRankH !== bRankH) {
      return bRankH - aRankH;
    }

    /**
     * At equal resolution and comparable health, picture richness is the
     * deciding quality signal. It deliberately runs before delivery format,
     * adaptive-ladder and provider-name preferences: those are useful
     * reliability conveniences, but they must not make a 2 Mbps 1080p encode
     * beat a 10 Mbps 1080p encode. Direct comparison is transitive, so
     * resolver arrival order cannot change the winner. A measured rate ranks
     * ahead of unknown evidence.
     */
    if (aRankH === bRankH) {
      const supportOrder = compareBitrateSustainability(a, b);
      if (supportOrder !== 0) return supportOrder;
      const bitrateOrder = compareNormalizedBitrates(
        normalizedBitrateForTarget(a, explicitTarget),
        normalizedBitrateForTarget(b, explicitTarget)
      );
      if (bitrateOrder !== 0) return bitrateOrder;
    }

    const aPref = pref && matchesPreference(a, pref) ? 1 : 0;
    const bPref = pref && matchesPreference(b, pref) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;

    // Delivery cost, height-gated (see compareDelivery). Must sit ABOVE the
    // premium-direct rule below: without it, a 1080p MKV debrid source would
    // use that rule to beat an equal-height embed that needs no server work
    // at all. It stays BELOW the height tiers, so a 4K remux still wins the
    // resolution it genuinely has.
    const deliveryOrder = compareDelivery(a, b, aH, bH);
    if (deliveryOrder !== 0) return deliveryOrder;

    /**
     * Premium direct-play beats an embed it does not lose height to.
     *
     * `isTopTierSource` cannot express this on its own: an HLS embed and a
     * natively-playable debrid source are BOTH top tier, so they tie there and
     * the multi-rendition test below decides instead — which debrid can never
     * win, because it is always progressive MP4 and has no ladder by
     * construction. Observed live: on Oppenheimer and Inception a Luna
     * embed with ladder [1080,720,480] took the pick over two and four healthy
     * native Real-Debrid 1080p sources respectively.
     *
     * Gated on the premium source being AT LEAST as tall, so this can never
     * cost real resolution while still letting it win outright when it is
     * taller. An earlier version required exactly equal heights, which
     * backfired: both sources sit in the same >=1080 tier, and the raw height
     * comparison happens AFTER the ladder test, so a native 4K debrid source
     * lost to a 1080p embed that merely had a ladder. Observed live on
     * Inception, whose roster carries a real `4K • Debrid`
     * (compat=native, container=mp4) that was being passed over for Luna 1080p.
     * A SHORTER premium source still falls through and loses on height, as it
     * should. Embed-vs-embed is untouched.
     *
     * The trade, stated plainly: a fixed 1080p direct-CDN file over an
     * adaptive ladder that could downshift under pressure. That is the right
     * call here — the debrid link skips the residential double-hop proxy
     * entirely, and the ladders it competes against are frequently slow (the
     * Luna above probed speedScore 16/100).
     */
    const aPremiumDirect = a.origin === "debrid" && isSourcePlayableHere(a);
    const bPremiumDirect = b.origin === "debrid" && isSourcePlayableHere(b);
    if (aPremiumDirect !== bPremiumDirect) {
      if (aPremiumDirect && aH >= bH) return -1;
      if (bPremiumDirect && bH >= aH) return 1;
    }

    const aLadder = isMultiRendition(a) ? 1 : 0;
    const bLadder = isMultiRendition(b) ? 1 : 0;
    if (aLadder !== bLadder) return bLadder - aLadder;

    const aTop = isTopTierSource(a) ? 1 : 0;
    const bTop = isTopTierSource(b) ? 1 : 0;
    if (aTop !== bTop) return bTop - aTop;

    const prio = sourceFailoverPriority(b) - sourceFailoverPriority(a);
    if (prio !== 0) return prio;

    if (a.probe?.ok && b.probe?.ok) {
      const sd = b.probe.speedScore - a.probe.speedScore;
      if (Math.abs(sd) >= 15) return sd;
    }

    const aHevc = isHevcSource(a) && !browserSupportsHevc() ? 1 : 0;
    const bHevc = isHevcSource(b) && !browserSupportsHevc() ? 1 : 0;
    if (aHevc !== bHevc) return aHevc - bHevc;
    const scoreOrder = scoreSource(b) - scoreSource(a);
    return scoreOrder !== 0 ? scoreOrder : a.id.localeCompare(b.id);
  });
  return sorted[0] ?? null;
}

export function hasResolutionHint(text: string): boolean {
  return RESOLUTION_PATTERNS.some((re) => re.test(text));
}
