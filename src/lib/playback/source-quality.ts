import type { PlaybackSource, SourceProbeMetrics } from "./types";
import { DEFAULT_SOURCE_KEY } from "@/lib/player-preferences";
import {
  isNeverAutoDefaultUrl,
  isPoisonStreamUrl,
  POISON_SCORE_PENALTY,
} from "./poison-url";
import { isBrowserPlayableContainer } from "./debrid/torrentio";

/**
 * Live-transcode target cap (task: transcode-target policy). 4K live
 * transcoding on the owner's single shared VAAPI encoder is slow-starting
 * (~0.9x realtime — see mini-services/transcoder/index.ts) so anything
 * routed through /api/transcode is capped to this height regardless of the
 * source's real ceiling: a 4K HEVC/MKV source becomes a smooth, universal
 * 1080p H.264 ABR ladder that starts reasonably fast. Real 4K playback only
 * ever happens on the native-decode path (e.g. Safari playing a 4K
 * HEVC-in-MP4 source directly — HEVC is native there, no transcode needed at
 * all); MKV/WebM never has a native path on ANY browser, so a 4K MKV source
 * is always delivered at this cap, never the source's true 4K. Shared with
 * video-player.tsx so the actual encode height and the badge/UI claim can
 * never drift apart.
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

/**
 * Settings preferred quality → ranking target height.
 * `"auto"` is the 1080p floor (ABR may climb after start); never below floor.
 */
export function resolvePreferredHeightTarget(
  pref: "auto" | number | null | undefined
): number {
  if (pref == null || pref === "auto") return HD_FLOOR_HEIGHT;
  return Math.max(HD_FLOOR_HEIGHT, pref);
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
  if (source.verified === false) return "weak";
  if (source.probe?.ok === false) return "weak";
  if (source.probe?.ok === true) return "healthy";
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
 * Badge height — honest about what will ACTUALLY be delivered. A source
 * this browser can't decode natively is routed through /api/transcode
 * (video-player.tsx's `needsTranscode`), which caps its ladder at
 * `TRANSCODE_MAX_HEIGHT` (live 4K transcoding is too slow-starting to offer
 * — see mini-services/transcoder). So a 4K HEVC/MKV source viewed on Chrome
 * must badge as "1080p", never "4K" — the badge would otherwise promise a
 * resolution the transcode path never actually produces. Playable-here
 * sources (native decode, or Safari decoding HEVC/AV1 natively) are
 * unaffected and keep their real height.
 */
function baseQualityBadge(source: PlaybackSource): string {
  const rawHeight = sourceMaxHeight(source);
  const h = isSourcePlayableHere(source)
    ? rawHeight
    : Math.min(rawHeight, TRANSCODE_MAX_HEIGHT);
  if (h >= 2160) return "4K";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h > 0) return `${h}p`;
  if (source.type === "hls") return "Adaptive";
  return source.quality !== "auto" ? source.quality : "Auto";
}

/**
 * Short, honest marker for a source that needs the in-container transcoder
 * rather than native decode. Previously this named the OTHER browser that
 * could play the release directly ("· Safari" / "· Chrome") — that advice is
 * now obsolete (and, for MKV/WebM, was actively WRONG: no browser, including
 * Safari, plays those containers) now that /api/transcode exists. "transcode"
 * is true regardless of which browser is viewing: it never implies native
 * playback, and it never tells the owner to switch browsers when the app
 * already handles it server-side (with a short startup delay — see the
 * player's "Preparing stream…" state).
 */
const TRANSCODE_BADGE_TAG = "transcode";

export function qualityBadge(source: PlaybackSource): string {
  const badge = baseQualityBadge(source);
  // Honest label: a release this browser can't decode/demux natively must
  // say so in the Server list BEFORE the owner clicks it — "1080p ·
  // transcode" rather than a bare "4K" implying native playback here.
  const withCompatTag = isSourcePlayableHere(source)
    ? badge
    : `${badge} · ${TRANSCODE_BADGE_TAG}`;
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
 * Cached once per session — capability never changes mid-session, and this
 * runs per-source inside hot ranking paths (scoreSource/pickDefaultSource
 * over a 30-40 source roster), so re-probing on every call is wasted work.
 */
let hevcSupportCache: boolean | null = null;

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
  if (hevcSupportCache !== null) return hevcSupportCache;
  hevcSupportCache = detectHevcSupport();
  return hevcSupportCache;
}

function detectHevcSupport(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const mse = typeof MediaSource !== "undefined" ? MediaSource : null;
    if (
      mse?.isTypeSupported &&
      (mse.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
        mse.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"'))
    ) {
      return true;
    }
  } catch {
    /* fall through to the <video> progressive check below */
  }
  if (typeof document === "undefined") return false;
  try {
    const video = document.createElement("video");
    const hvc1 = video.canPlayType('video/mp4; codecs="hvc1"');
    const hev1 = video.canPlayType('video/mp4; codecs="hev1"');
    return hvc1 === "probably" || hvc1 === "maybe" || hev1 === "probably" || hev1 === "maybe";
  } catch {
    return false;
  }
}

/** Same cache pattern as `hevcSupportCache` — capability is static per session. */
let av1SupportCache: boolean | null = null;

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
  if (av1SupportCache !== null) return av1SupportCache;
  av1SupportCache = detectAv1Support();
  return av1SupportCache;
}

function detectAv1Support(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const mse = typeof MediaSource !== "undefined" ? MediaSource : null;
    if (mse?.isTypeSupported && mse.isTypeSupported('video/mp4; codecs="av01.0.05M.08"')) {
      return true;
    }
  } catch {
    /* fall through to the <video> progressive check below */
  }
  if (typeof document === "undefined") return false;
  try {
    const video = document.createElement("video");
    const av1 = video.canPlayType('video/mp4; codecs="av01.0.05M.08"');
    return av1 === "probably" || av1 === "maybe";
  } catch {
    return false;
  }
}

/**
 * False for a release this exact browser cannot play WITHOUT the
 * /api/transcode route. Container-first, then codec-first, independent of
 * `compat`:
 *  - Container: MKV/WebM play in NO browser, not even Safari, regardless of
 *    the codec inside (`isBrowserPlayableContainer`, shared with the
 *    debrid tier's own parser in torrentio.ts) — this is checked BEFORE
 *    codec so an MKV release is never mistakenly reported playable just
 *    because it happens to hold plain H.264. This also fixes a real bug
 *    where an `.mkv` source that Torrentio parsed as `compat:"native"`
 *    (H.264 inside, no HDR) was tagged natively playable even though no
 *    browser can open the container itself.
 *  - `codec:"av1"` — gated purely on `browserSupportsAv1()`, regardless of
 *    whatever `compat` the RD agent stamps on it (a release can be tagged
 *    `compat:"native"` for the HEVC/HDR/MKV sense and still be undecodable
 *    AV1 on an old Safari, or vice versa be `compat:"safari"`-tagged for an
 *    unrelated reason and still be fine AV1 on Chrome).
 *  - Everything else (`hevc`/`h264`/`unknown`) — the existing `compat`-based
 *    HEVC gate, unchanged.
 * Embed sources never carry `container`/`compat`/non-h264 `codec`, so they
 * always read true (unchanged: "always treated as natively playable" per
 * the type doc). Never used to hide a source — the Server list keeps it
 * selectable, routed through /api/transcode instead — only to
 * rank/badge/auto-pick it honestly.
 */
export function isSourcePlayableHere(source: PlaybackSource): boolean {
  if (source.container && !isBrowserPlayableContainer(source.container)) return false;
  if (source.codec === "av1") return browserSupportsAv1();
  return source.compat !== "safari" || browserSupportsHevc();
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
/** Large enough that a transcode-required (HEVC/AV1-incapable, or MKV/WebM) debrid source drops below a plain natively-playable 1080p source — transcoding has real startup latency, so it must never win a tie. */
const DEBRID_TRANSCODE_PENALTY = 220;

/**
 * PREMIUM debrid tier adjustment. A source that needs /api/transcode to play
 * here (HEVC/AV1 this browser can't decode, OR any MKV/WebM container —
 * `!isSourcePlayableHere`) must NOT outrank — and must not become the
 * auto-default over — a genuinely natively-playable source, so the penalty
 * only lifts when the source plays here without transcoding.
 */
function debridScoreAdjustment(source: PlaybackSource): number {
  if (source.origin !== "debrid") return 0;
  const needsTranscode = !isSourcePlayableHere(source);
  return DEBRID_BASE_BONUS - (needsTranscode ? DEBRID_TRANSCODE_PENALTY : 0);
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
 * Source picker: preferred first, then quality (height / multi-rung / verified),
 * then name. Servers act as the free-CDN quality ladder.
 */
export function sortSourcesForPicker(sources: PlaybackSource[]): PlaybackSource[] {
  const pref =
    typeof window !== "undefined" ? localStorage.getItem("cinehome:preferred-provider") : null;
  return [...sources].sort((a, b) => {
    const aMatch = pref && matchesPreference(a, pref) ? 1 : 0;
    const bMatch = pref && matchesPreference(b, pref) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;

    // Honesty (Server list, req 4): a release this browser can't play
    // natively (HEVC/AV1 needing another browser, or any MKV/WebM — now
    // routed through /api/transcode instead) never outranks one that
    // actually plays here — still selectable, just sorted below what's
    // playable (transcoding has real startup latency).
    const aPlayable = isSourcePlayableHere(a) ? 1 : 0;
    const bPlayable = isSourcePlayableHere(b) ? 1 : 0;
    if (aPlayable !== bPlayable) return bPlayable - aPlayable;

    const aVer = a.verified === false ? 0 : 1;
    const bVer = b.verified === false ? 0 : 1;
    if (aVer !== bVer) return bVer - aVer;

    const aOk = a.probe?.ok === true ? 1 : a.probe?.ok === false ? -1 : 0;
    const bOk = b.probe?.ok === true ? 1 : b.probe?.ok === false ? -1 : 0;
    if (aOk !== bOk) return bOk - aOk;

    const aMulti = isMultiRendition(a) ? 1 : 0;
    const bMulti = isMultiRendition(b) ? 1 : 0;
    if (aMulti !== bMulti) return bMulti - aMulti;

    const aH = sourceMaxHeight(a);
    const bH = sourceMaxHeight(b);
    if (aH !== bH) return bH - aH;

    const nameA = `${a.provider} ${a.label}`.toLowerCase();
    const nameB = `${b.provider} ${b.label}`.toLowerCase();
    return nameA.localeCompare(nameB);
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
  // #1 Solstice — most reliable through /api/hls for this setup
  if (isSolsticeSource(source)) return 100;
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
  // "videasy" is CinePro's LIVE OMSS sub-provider (surfaced as "Quasar") —
  // it only reaches this far down on its HEVC-source path (non-HEVC Quasar
  // already scores 80 via the CinePro branch above, same as Aether/Horizon).
  // It must never share a bucket with "lordflix", a fully dead API removed
  // from the active roster 2026-07-21 and kept below only so a stray cached
  // label never falls out of theme.
  if (p.includes("videasy")) return 2;
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
  const notHardDead = sources.filter(
    (s) =>
      s.probe?.ok !== false &&
      !isSoftKept(s) &&
      (!isHevcSource(s) || hevcOk) &&
      // A transcode-required debrid release (HEVC/AV1 this browser can't
      // decode, or any MKV/WebM container) must never auto-default over a
      // natively-playable source — same signal used for the score tax. It
      // is NOT removed from the roster: sortSourcesForPicker still lists it
      // (sorted below), and the fallback branch just below still returns it
      // when it's the ONLY thing available (e.g. a browser with no native
      // 4K path — a transcode-required 4K/MKV source is that browser's
      // ONLY way to get >1080p, so it must never be hidden outright).
      (s.origin !== "debrid" || isSourcePlayableHere(s))
  );
  if (!notHardDead.length) {
    const soft = sources.filter((s) => s.probe?.ok !== false);
    // Prefer non-poison even among soft fallbacks.
    const softClean = soft.filter((s) => !isNeverAutoDefaultUrl(s.url));
    if (softClean.length) return softClean;
    return soft.length ? soft : sources;
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
 * transcode-required debrid source never qualifies here (autoPlayPool
 * already excludes it from the auto-default pool entirely in that case,
 * though it stays visible/selectable in the picker).
 */
function isTopTierSource(source: PlaybackSource): boolean {
  if (isHlsSource(source)) return true;
  return source.origin === "debrid" && isSourcePlayableHere(source);
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
  /** Settings preferred quality height (`"auto"` → 1080 floor; 2160 prefers 4K). */
  preferredHeight?: "auto" | number | null
): PlaybackSource | null {
  if (!sources.length) return null;
  const pickPool = autoPlayPool(sources);
  const heightTarget = resolvePreferredHeightTarget(preferredHeight);

  // Honor stored preference only when non-empty and source is in the playable pool.
  // Never force Luna preference over probe-verified Aether/Horizon.
  const pref = (preferredProvider || DEFAULT_SOURCE_KEY || "").trim();
  if (pref) {
    const prefMatches = pickPool.filter((s) => matchesPreference(s, pref));
    if (prefMatches.length) {
      // Among preference matches: HD known > unknown > sub-HD (ranking only).
      const sortedPref = [...prefMatches].sort((a, b) => {
        const aH = sourceMaxHeight(a) || 0;
        const bH = sourceMaxHeight(b) || 0;
        const tier = (h: number) => (h >= HD_FLOOR_HEIGHT ? 2 : h <= 0 ? 1 : 0);
        if (tier(aH) !== tier(bH)) return tier(bH) - tier(aH);
        const aT = aH >= heightTarget ? 1 : 0;
        const bT = bH >= heightTarget ? 1 : 0;
        if (aT !== bT) return bT - aT;
        if (aH !== bH) return bH - aH;
        const aHevc = isHevcSource(a) && !browserSupportsHevc() ? 1 : 0;
        const bHevc = isHevcSource(b) && !browserSupportsHevc() ? 1 : 0;
        if (aHevc !== bHevc) return aHevc - bHevc;
        return 0;
      });
      const nonHevc = sortedPref.find((s) => !isHevcSource(s) || browserSupportsHevc());
      return nonHevc || sortedPref[0] || null;
    }
  }

  // Ranking only — never filters the pool empty.
  // Poison gate first, then height tiers, multi-rung / probe / prio.
  const sorted = [...pickPool].sort((a, b) => {
    const aPoison = isPoisonStreamUrl(a.url) ? 1 : 0;
    const bPoison = isPoisonStreamUrl(b.url) ? 1 : 0;
    if (aPoison !== bPoison) return aPoison - bPoison;

    const aH = sourceMaxHeight(a) || 0;
    const bH = sourceMaxHeight(b) || 0;
    const heightTier = (h: number): number => {
      if (h >= HD_FLOOR_HEIGHT) return 2;
      if (h <= 0) return 1; // unknown — not treated as sub-HD
      return 0;
    };
    const aTier = heightTier(aH);
    const bTier = heightTier(bH);
    if (aTier !== bTier) return bTier - aTier;

    if (heightTarget > HD_FLOOR_HEIGHT && aTier === 2) {
      const aT = aH >= heightTarget ? 1 : 0;
      const bT = bH >= heightTarget ? 1 : 0;
      if (aT !== bT) return bT - aT;
    }

    const aOk = a.probe?.ok ? 1 : 0;
    const bOk = b.probe?.ok ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;

    const aVer = a.verified === false ? 0 : 1;
    const bVer = b.verified === false ? 0 : 1;
    if (aVer !== bVer) return bVer - aVer;

    const aLadder = isMultiRendition(a) ? 1 : 0;
    const bLadder = isMultiRendition(b) ? 1 : 0;
    if (aLadder !== bLadder) return bLadder - aLadder;

    const aTop = isTopTierSource(a) ? 1 : 0;
    const bTop = isTopTierSource(b) ? 1 : 0;
    if (aTop !== bTop) return bTop - aTop;

    if (aH !== bH) return bH - aH;

    const prio = sourceFailoverPriority(b) - sourceFailoverPriority(a);
    if (prio !== 0) return prio;

    if (a.probe?.ok && b.probe?.ok) {
      const sd = b.probe.speedScore - a.probe.speedScore;
      if (Math.abs(sd) >= 15) return sd;
    }

    const aHevc = isHevcSource(a) && !browserSupportsHevc() ? 1 : 0;
    const bHevc = isHevcSource(b) && !browserSupportsHevc() ? 1 : 0;
    if (aHevc !== bHevc) return aHevc - bHevc;
    return scoreSource(b) - scoreSource(a);
  });
  return sorted[0] ?? null;
}

export function hasResolutionHint(text: string): boolean {
  return RESOLUTION_PATTERNS.some((re) => re.test(text));
}