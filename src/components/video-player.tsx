"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import type { PlaybackSource, SourceProbeMetrics } from "@/lib/playback/types";
import { getServerDisplayName } from "@/lib/playback/server-names";
import {
  pickDefaultSource,
  sortSourcesForPicker,
  preferenceKey,
  isFasterSource,
  sourceMaxHeight,
  formatResolutionLabel,
  decodedQualityHeight,
  findNewSourceIds,
  withDetectedSourceHeight,
  withClientHealthProbe,
  speedScoreFromLatencyMs,
  isMultiRendition,
  isSourcePlayableHere,
  HD_FLOOR_HEIGHT,
  TRANSCODE_MAX_HEIGHT,
  eligiblePlaybackSources,
} from "@/lib/playback/source-quality";
import { dedupePlaybackSources } from "@/lib/playback/source-identity";
import { isPoisonStreamUrl } from "@/lib/playback/poison-url";
import { firstFrameWallMs } from "@/lib/playback/first-frame-wall";
import {
  SourceAttemptController,
  type SourceAttemptToken,
} from "@/lib/playback/source-attempt";
import { MediaPauseIntentController } from "@/lib/playback/pause-intent";
import { preresolvePlayback } from "@/lib/playback-preresolve";
import {
  annotateLevelHeights,
  effectiveLevelHeight,
  findBestLevelForTarget,
  findMinLevelIndexForHeight,
  hlsPromotionTargetHeight,
  maxLevelHeight,
  pickDefaultQualityIndex,
  planHlsRecovery,
  ADAPTIVE_CLIMB_BUFFER_SECONDS,
} from "@/lib/playback/hls-quality";
import {
  applyHlsRecoveryPlan,
  seedNextAutoLevel,
} from "@/lib/playback/hls-engine-policy";
import {
  getPreferredProvider,
  getPreferredQualityHeight,
  getPreferredAudioLanguage,
  getSavedPlaybackSpeed,
  setPreferredProvider,
  setPreferredAudioLanguage,
  setSavedPlaybackSpeed,
  getQualityFloorPolicy,
  type QualityFloorPolicy,
} from "@/lib/player-preferences";
import Hls from "hls.js";
import type { MediaPlayerClass } from "dashjs";
import { Play, Loader2, RefreshCw, X, ArrowLeft, ArrowLeftRight, ArrowUpDown } from "lucide-react";
import { usePlayerStore, type MediaTrack, type QualityLevel } from "@/stores/player-store";
import { PlayerControls } from "@/components/player-controls";
import { LoadingScreen } from "@/components/player/LoadingScreen";
import { PlayerErrorCard, type PlayerErrorAction } from "@/components/player/PlayerErrorCard";
import { SkipIntroButton } from "@/components/player/SkipIntroButton";
import type { DockSection } from "@/components/player-dock";
import {
  buildPlayerQualityOptions,
  qualityLabel as playerQualityLabel,
  shouldCommitQualityTarget,
  type PlayerQualityTarget,
} from "@/lib/playback/quality-router";

const CONTROLS_HIDE_MS = 3000;
const SWIPE_SEEK_SECONDS = 10;
const SWIPE_MIN_PX = 40;
const SWIPE_HINT_VISIBLE_MS = 2200;
const SWIPE_HINT_FADE_MS = 500;
const ALL_SOURCES_FAILED_MSG =
  "No playable server for this title right now. Retry full for a fresh resolve.";

/**
 * Double-hop residential proxy buffer policy.
 * Product quality: HD-first (1080p→4K when the source has it), honest
 * degrade to the source's real ceiling otherwise — never soft-start or
 * stall-dip below what the connection can sustain.
 *
 * Buffer tuning (verified/tuned for smoothness on a home connection):
 * - `maxBufferLength` 30s: steady-state forward-buffer target hls.js tries
 *   to maintain once playback is healthy — enough to absorb a multi-second
 *   double-hop proxy hiccup without stalling, small enough to reach that
 *   target quickly on a cold start.
 * - `maxMaxBufferLength` 60s: the ceiling hls.js's own back-off logic may
 *   grow toward under sustained good bandwidth (never forced, just allowed)
 *   — matches the "30-60s forward" smoothness target.
 * - `maxBufferSize` 64MB: bytes cap that bounds memory regardless of the
 *   above; big enough to hold ~60s of a typical re-encoded 1080p rung
 *   (~5-8Mbps) without hls.js prematurely evicting buffer, small enough to
 *   stay bounded if a 4K rung is active.
 * - `backBufferLength` 30s (was 60s): kept for instant-rewind within the
 *   last half-minute; halved from the previous value because 60s back +
 *   up to 60s forward could double-book ~120s of media in memory at once
 *   for no smoothness benefit — 30s is the "modest" side of this tradeoff,
 *   forward buffer-ahead is what actually prevents stalls.
 */
/** Forward buffer — enough for mid-play stalls without ballooning memory. */
const HLS_MAX_BUFFER_LENGTH_S = 30;
const HLS_MAX_MAX_BUFFER_LENGTH_S = 60;
const HLS_MAX_BUFFER_SIZE_BYTES = 64_000_000;
/** Modest back-buffer — bounds memory; forward buffer-ahead is what prevents stalls. */
const HLS_BACK_BUFFER_LENGTH_S = 30;
/**
 * Initial (pre-measurement) bandwidth guess for ABR. ~8Mbps sits above
 * typical re-encoded 1080p (~3-6Mbps) so the first fragments climb past the
 * floor quickly without pretending the line is multi-gigabit 4K. hls.js
 * corrects from real measurement within the first couple of segments
 * (`abrEwmaFastVoD`/`abrEwmaSlowVoD`). Product rule: start at lowest ≥1080,
 * never force absolute max (4K) as the default start level.
 */
/** ~10 Mbps — start ABR near 1080p instead of hls.js default 500 kbps. */
const HLS_ABR_DEFAULT_ESTIMATE_BPS = 10_000_000;
/** Preload next TV episode sources at this progress ratio. */
const NEXT_EP_PRELOAD_RATIO = 0.8;
/** Hard floor — never load below this when a ≥1080 rung exists. */
const HLS_MIN_HEIGHT = HD_FLOOR_HEIGHT;
/** Product default / fixed preference target. */
const HLS_TARGET_HEIGHT = HD_FLOOR_HEIGHT;
/** Auto ABR may climb to 4K; never below HLS_MIN_HEIGHT. */
const HLS_AUTO_MAX_HEIGHT = 2160;

// ── Adaptive quality floor (Netflix-style) ─────────────────────────────────
// When the quality-floor policy is "adaptive" (the default), sustained
// bandwidth starvation is allowed to drop *temporarily* below the 1080 floor
// to keep video playing (Netflix/YouTube behavior), then climbs back as the
// line recovers. The "absolute" policy keeps the old "never below 1080p,
// buffer at the floor indefinitely" behavior.
/** Lowest rung the adaptive policy will ever drop to (never below this). */
/**
 * How low (relative to current) to drop per adaptive step. Each sustained stall
 * drops to the next rung at-or-below (current × 0.6), floor at ADAPTIVE_FLOOR_MIN_HEIGHT.
 */
/**
 * Buffer health (seconds ahead of playhead) above which we attempt to climb
 * back toward the floor / Auto after a downshift. Matches Netflix's
 * "buffer recovered, ramp quality up" heuristic.
 */
/** Buffer below this (seconds) while stalled is the trigger to downshift. */
/** Lowered from 20s — a single fragment hanging this long is already a strong
 * slow-CDN signal worth retrying/counting sooner (was masking real stalls). */
const HLS_FRAG_LOADING_TIMEOUT_MS = 12_000;
/**
 * Vixsrc multi-variant **media** playlists are ~0.5MB after proxy rewrite and
 * often need 10–20s on first CDN hop. Sub-10s timeouts abort mid-body, prevent
 * manifest cache fill (with client abort), and thrash under the R8 wall (R10).
 */
const HLS_MANIFEST_LOADING_TIMEOUT_MS = 20_000;
const HLS_LEVEL_LOADING_TIMEOUT_MS = 30_000;
const HLS_FRAG_LOADING_MAX_RETRY = 5;
const HLS_STALL_RECOVER_DEBOUNCE_MS = 1500;
const HLS_MAX_NETWORK_RECOVERIES = 3;
/** A signed-URL refresh must either produce a new generation or fail over. */
const HLS_SESSION_REFRESH_TIMEOUT_MS = 45_000;
/** Engine-agnostic backstop: playhead-not-advancing-while-playing poll cadence. */
const STALL_WATCHDOG_POLL_MS = 3_000;
/** No forward progress for this long while "playing" counts as a real stall.
 * The shared source-attempt controller allows one engine recovery nudge; a
 * second complete window without progress fails over. */
const STALL_WATCHDOG_THRESHOLD_MS = 12_000;
/**
 * Direct progressive MP4 has no engine recovery primitive: unlike hls.js or
 * dash.js, there is no loader to restart after the browser's opaque media
 * request dies. Waiting through a fake "recovery" cycle doubled failover to
 * ~24s. One bounded window is enough, and still comfortably exceeds measured
 * healthy RD seek latency (~2s).
 */
const NATIVE_PROGRESSIVE_STALL_THRESHOLD_MS = 8_000;
const STALL_WATCHDOG_MIN_ADVANCE_S = 0.34;
/** Grace period after background discovery closes before re-checking for a
 * stuck "Finding sources…" spinner with nothing left to try (task 2). */
const DISCOVERY_CLOSED_GRACE_MS = 1_500;
/** Shown when autoplay was rejected unmuted and we retried muted. */
const MUTED_AUTOPLAY_HINT = "Tap to unmute";
/**
 * Auto-upgrade only before the first healthy play. After first healthy frames,
 * never tear down for a "better" CDN (user dock pick still allowed).
 */
const AUTO_UPGRADE_MAX_POSITION_S = 8;
/** Sticky source: once past this, never re-pick on probe enrich (unless active failed). */
const STICKY_SOURCE_MIN_POSITION_S = 8;
/** Mark stream healthy (locks auto-upgrade) after this much continuous play. */
const HEALTHY_PLAY_LOCK_S = 2;
/** Hard HTTP statuses that count toward immediate failover (CDN / proxy denials). */
const HLS_HARD_HTTP_CODES = new Set([
  403,
  404,
  410,
  428,
  502,
  503,
  520,
  521,
  522,
  524,
]);
/** If play never advances past t≈0 after load, fail over (stuck Aether/PNG ads). */
/** Cold start: allow large pure-media level fetch after multi-variant master (R10). */
const HLS_ZERO_PROGRESS_FAIL_MS = 22_000;
/** Longer zero-progress window while waiting for mid-title resume seek. */
const HLS_ZERO_PROGRESS_FAIL_RESUME_MS = 22_000;
/**
 * Transcode startup (task 5): /api/transcode's own worst case is bounded by
 * the route's TRANSCODER_TIMEOUT_MS (45s fetch to the transcoder) plus a
 * short /key lookup — the transcoder itself returns as soon as the FIRST
 * segment exists (mini-services/transcoder's `waitForPlaylist`, 30s budget),
 * not after the full encode, but a cold VAAPI/libx264 start on a busy
 * encoder can legitimately take most of that window. The default
 * HLS_MANIFEST_LOADING_TIMEOUT_MS (20s)/HLS_ZERO_PROGRESS_FAIL_MS (22s) are
 * both too short for this and would fail a transcode source over before the
 * transcoder ever gets a chance — these give it the room it needs while
 * still being a hard, bounded ceiling (never infinite): past this, the
 * player fails over to the next source exactly like any other stuck stream.
 */
const TRANSCODE_MANIFEST_LOADING_TIMEOUT_MS = 50_000;
/** Zero-progress ceiling for a transcoded source — slightly above the manifest timeout so the first fragment has a moment to download/decode after a manifest that arrives right at the wire. */
const TRANSCODE_ZERO_PROGRESS_FAIL_MS = 52_000;
/** Resume position above this uses the extended zero-progress / first-frame wall. */
const RESUME_SLOW_THRESHOLD_S = 5;
/** Min position (s) worth preserving across source switches. */
const RESUME_CAPTURE_MIN_S = 1;
/** Abandon late resume only if playback is already past target + slack (user scrub). */
const RESUME_ABANDON_SLACK_S = 2;
/** Sleep timer toast copy when the timer pauses playback. */
const SLEEP_TIMER_PAUSED_MSG = "Sleep timer — paused";
/** One-shot chip after hard-error failover to another source. */
const FAILOVER_NOTICE_MS = 4_500;
/** Non-blocking "New source available" chip — auto-dismiss (still dismissible). */
const NEW_SOURCE_NOTICE_MS = 8_000;
const NEW_SOURCE_NOTICE_MSG = "New source available";
/** "Resuming from mm:ss" one-shot toast shown when a continue-watching seek lands. */
const RESUME_NOTICE_MS = 4_000;

/**
 * Background Server-list health probing (client-side, bounded + cached).
 * The full-scrape server probe (`source.probe`, see source-quality.ts) never
 * covers every source — this fills the gap for sources it skipped so the
 * Server list's health dot is honest instead of stuck on "unknown" forever.
 * Bounded concurrency + a TTL cache mean a large roster or a revisited title
 * never floods the network. This NEVER drives auto-selection (that stays
 * ranking/pickDefaultSource-driven) and NEVER overwrites a server-measured
 * probe — it only fills in badges/health dots for sources the server never
 * got around to probing.
 */
const BG_HEALTH_PROBE_CONCURRENCY = 2;
const BG_HEALTH_PROBE_TIMEOUT_MS = 4_000;
const BG_HEALTH_PROBE_CACHE_TTL_MS = 3 * 60 * 1000;
/** Queue depth cap per pass — a large roster still only ever has
 * BG_HEALTH_PROBE_CONCURRENCY requests in flight at once. */
const BG_HEALTH_PROBE_MAX_PER_PASS = 8;

interface CachedHealthProbe {
  probe: SourceProbeMetrics;
  expiresAt: number;
}
/** Module-scope: survives source-switch/title-switch re-renders within the
 * same tab so a source probed once this session is never re-probed within
 * the TTL, even across episodes. */
const bgHealthProbeCache = new Map<string, CachedHealthProbe>();

function isSameOriginPlaybackUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * One bounded reachability check against a same-origin source URL. We never
 * "probe" a cross-origin media file with an opaque no-cors GET: that cannot
 * prove status and can accidentally start downloading the whole asset.
 */
async function probeSourceReachability(url: string): Promise<SourceProbeMetrics> {
  if (!isSameOriginPlaybackUrl(url)) {
    return { ok: false, ttfbMs: 0, bytesPerSec: 0, speedScore: 0 };
  }
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      mode: "same-origin",
      signal: AbortSignal.timeout(BG_HEALTH_PROBE_TIMEOUT_MS),
      headers: { Range: "bytes=0-16384" },
    });
    const ttfbMs = Math.max(1, Date.now() - start);
    const ok = res.ok || res.status === 206;
    return {
      ok,
      ttfbMs,
      bytesPerSec: 0,
      speedScore: ok ? speedScoreFromLatencyMs(ttfbMs) : 0,
    };
  } catch {
    return { ok: false, ttfbMs: BG_HEALTH_PROBE_TIMEOUT_MS, bytesPerSec: 0, speedScore: 0 };
  }
}

async function probeSourceReachabilityCached(url: string): Promise<SourceProbeMetrics> {
  const now = Date.now();
  const cached = bgHealthProbeCache.get(url);
  if (cached && cached.expiresAt > now) return cached.probe;
  const probe = await probeSourceReachability(url);
  bgHealthProbeCache.set(url, { probe, expiresAt: now + BG_HEALTH_PROBE_CACHE_TTL_MS });
  return probe;
}

/** Bounded-concurrency queue — never more than `concurrency` probes in
 * flight at once, regardless of how many candidate URLs are queued. */
async function runBoundedHealthProbes(
  urls: string[],
  concurrency: number,
  onEach: (url: string, probe: SourceProbeMetrics) => void
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++]!;
      const probe = await probeSourceReachabilityCached(url);
      onEach(url, probe);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker())
  );
}

interface Props {
  sources: PlaybackSource[];
  sourcesLoading?: boolean;
  sourcesError?: string | null;
  onRetrySources?: () => void | Promise<void>;
  isDiscoveringSources?: boolean;
  /** Authenticated profile default from the playback response. */
  profileQuality?: PlayerQualityTarget;
  /** Changes when a cache-bypassing roster recovery returns. */
  refreshNonce?: number;
  /** Progressive source count for loading status. */
  sourceCount?: number;
  poster?: string | null;
  title: string;
  mediaType?: "movie" | "tv";
  /** TMDB id of the title — used to build the transcode URL for HEVC/AV1 sources
   * the browser can't decode natively (routed through /api/transcode). */
  tmdbId?: number;
  initialTime?: number;
  onProgress?: (current: number, duration: number) => void;
  onEnded?: () => void;
  hasNextEpisode?: boolean;
  onNextEpisode?: () => void;
  /** Preload next episode sources (TV binge). */
  nextEpisodeTarget?: { season: number; episode: number } | null;
  /** Lordflix top-bar back */
  onBack?: () => void;
  /** TV episode picker (optional) */
  tvId?: number;
  tvSeasons?: { season_number: number; name?: string; episode_count?: number }[];
  tvSeason?: number;
  tvEpisode?: number;
  onSelectEpisode?: (season: number, episode: number) => void;
}

function isSessionExpiredError(data: { response?: { code?: number }; details?: string; reason?: string; url?: string }): boolean {
  const code = data.response?.code;
  const detail = String(data.details ?? data.reason ?? "").toLowerCase();
  const url = String(data.url ?? "").toLowerCase();
  return (
    code === 410 ||
    detail.includes("410") ||
    detail.includes("session expired") ||
    url.includes("session expired")
  );
}

/**
 * Autoplay with a muted-retry fallback: browsers reject unmuted autoplay
 * (NotAllowedError) far more often than muted autoplay. Retrying muted keeps
 * playback moving instead of leaving the user staring at a paused frame;
 * `onMutedFallback` should surface a "tap to unmute" affordance.
 */
function attemptAutoplay(
  video: HTMLVideoElement,
  onBlocked: () => void,
  onMutedFallback?: () => void
) {
  video.play().catch((err: unknown) => {
    const isNotAllowed = err instanceof DOMException && err.name === "NotAllowedError";
    if (isNotAllowed && !video.muted && onMutedFallback) {
      video.muted = true;
      video.play().then(onMutedFallback, () => onBlocked());
      return;
    }
    onBlocked();
  });
}

/** mm:ss (h:mm:ss past an hour) — used only for the "Resuming from …" toast. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isEnglishTrack(lang?: string, name?: string): boolean {
  const l = (lang ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  return l.startsWith("en") || n.includes("english") || n.includes("eng");
}

/** Base label for an audio track (lang-aware); disambiguate duplicates with track index. */
function formatAudioTrackLabel(
  track: { name?: string; lang?: string; channels?: string },
  index: number,
  all: Array<{ name?: string; lang?: string }>
): string {
  const lang = (track.lang ?? "").toLowerCase();
  const name = (track.name ?? "").trim();
  let base: string;
  if (lang.startsWith("en") || name.toLowerCase().includes("english")) {
    base = "English";
  } else if (name) {
    base = name;
  } else if (track.lang) {
    base = track.lang.toUpperCase();
  } else {
    base = `Audio ${index + 1}`;
  }

  if (all.length <= 1) return base;

  const langKey = lang || name.toLowerCase() || `idx-${index}`;
  const sameLang = all.filter((t, i) => {
    const k = (t.lang ?? "").toLowerCase() || (t.name ?? "").toLowerCase() || `idx-${i}`;
    return k === langKey;
  });
  if (sameLang.length <= 1) return base;

  const ordinal =
    all
      .map((t, i) => ({ t, i }))
      .filter(({ t, i }) => {
        const k = (t.lang ?? "").toLowerCase() || (t.name ?? "").toLowerCase() || `idx-${i}`;
        return k === langKey;
      })
      .findIndex(({ i }) => i === index) + 1;

  if (name && name.toLowerCase() !== base.toLowerCase() && !name.toLowerCase().includes("english")) {
    return `${base} · ${name}`;
  }
  if (track.channels) {
    return `${base} · ${track.channels} · Track ${ordinal}`;
  }
  return `${base} · Track ${ordinal}`;
}

/** Prefer hls.js track.id (not array index) so dock selection matches AUDIO/SUBTITLE events. */
function mapAudioTracks(hls: Hls): MediaTrack[] {
  const raw = hls.audioTracks;
  return raw.map((t, i) => ({
    id: typeof t.id === "number" ? t.id : i,
    name: formatAudioTrackLabel(t, i, raw),
    lang: t.lang || undefined,
    channels: t.channels || undefined,
  }));
}

function mapSubtitleTracks(hls: Hls): MediaTrack[] {
  return hls.subtitleTracks.map((t, i) => ({
    id: typeof t.id === "number" ? t.id : i,
    name: t.name || t.lang || `Subtitle ${i + 1}`,
    lang: t.lang || undefined,
  }));
}

/** Safari native HLS: surface TextTrackList so dock can list captions when present. */
function mapNativeTextTracks(video: HTMLVideoElement): MediaTrack[] {
  const list = video.textTracks;
  const out: MediaTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    if (t.kind !== "subtitles" && t.kind !== "captions") continue;
    // Ignore metadata / forced-only empty labels when kind is wrong already filtered
    out.push({
      id: i,
      name: t.label || t.language || `Subtitle ${out.length + 1}`,
      lang: t.language || undefined,
    });
  }
  return out;
}

/** Safari audioTracks (non-standard) for multi-audio native HLS. */
function mapNativeAudioTracks(video: HTMLVideoElement): MediaTrack[] {
  const media = video as HTMLVideoElement & {
    audioTracks?: {
      length: number;
      [index: number]: { id?: string; label?: string; language?: string; enabled?: boolean };
    };
  };
  const list = media.audioTracks;
  if (!list || list.length === 0) return [];
  const raw: Array<{ name?: string; lang?: string }> = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    raw.push({ name: t.label || undefined, lang: t.language || undefined });
  }
  const out: MediaTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    out.push({
      id: i,
      name: formatAudioTrackLabel(
        { name: t.label || undefined, lang: t.language || undefined },
        i,
        raw
      ),
      lang: t.language || undefined,
    });
  }
  return out;
}

/**
 * Map hls.js levels → QualityLevel with full height annotation.
 * Uses native RESOLUTION, bitrate heuristics, and scraper ladder/maxHeight
 * so the Quality menu lists every real rung (not a single wrong 480/720).
 */
function mapHlsLevels(
  hls: Hls,
  sourceMaxHeightFallback = 0,
  sourceLadder: ReadonlyArray<number> = []
): QualityLevel[] {
  const raw: QualityLevel[] = hls.levels.map((l, i) => ({
    height: l.height || 0,
    width: l.width || 0,
    index: i,
    bitrate: l.bitrate,
  }));
  return annotateLevelHeights(raw, sourceLadder, sourceMaxHeightFallback);
}

/**
 * Best start level: ≥1080 preferred, else highest on ladder. Delegates to
 * the shared hls-quality.ts helper so the player's default pick can never
 * disagree with the picker's own "default selection" logic.
 */
function pickStartLevelIndex(levels: QualityLevel[]): number {
  return pickDefaultQualityIndex(levels);
}

/**
 * Highest-bitrate level with height <= maxHeight — used as hls.autoLevelCapping
 * (level index; hls.js levels are bandwidth-ascending).
 */
function findAutoLevelCapIndex(levels: QualityLevel[], maxHeight: number): number {
  let bestIdx = -1;
  let bestBitrate = -1;
  for (const level of levels) {
    const height = effectiveLevelHeight(level);
    if (height <= 0 || height > maxHeight) continue;
    const bitrate = level.bitrate ?? 0;
    if (bitrate > bestBitrate || (bitrate === bestBitrate && level.index > bestIdx)) {
      bestBitrate = bitrate;
      bestIdx = level.index;
    }
  }
  return bestIdx;
}

/**
 * Apply one shared recovery policy to hls.js. Every caller passes the real
 * video element, so adaptive decisions use measured forward buffer rather than
 * an "unknown" sentinel that accidentally forced 1080p during starvation.
 * Live recovery never writes currentLevel because hls.js documents that setter
 * as a full forward-buffer flush.
 */
function recoverHlsAdaptive(
  hls: Hls,
  video: HTMLVideoElement,
  preferredHeight: PlayerQualityTarget = getPreferredQualityHeight()
): void {
  const levelList = mapHlsLevels(hls);
  const cur = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
  const plan = planHlsRecovery(levelList, cur, preferredHeight, {
    bufferAheadSeconds: bufferedAheadSeconds(video),
    policy: getQualityFloorPolicySafe(),
  });

  applyHlsRecoveryPlan(hls, plan);

  try {
    hls.startLoad();
  } catch {
    /* ignore */
  }
}

/** SSR-safe read of the floor policy (defaults to adaptive on the server). */
function getQualityFloorPolicySafe(): QualityFloorPolicy {
  try {
    return getQualityFloorPolicy();
  } catch {
    return "adaptive";
  }
}

function applyHlsAutoLevelCap(hls: Hls, levels: QualityLevel[]): void {
  const capIdx = findAutoLevelCapIndex(levels, HLS_AUTO_MAX_HEIGHT);
  if (capIdx >= 0) hls.autoLevelCapping = capIdx;
  // Floor enforcement lives in the LEVEL_SWITCHING/LEVEL_SWITCHED guards
  // (registered where the hls.js instance is created) — hls.js has no
  // native minAutoLevel setting, so there is nothing to set here.
}

/**
 * Apply stored quality preference the same way as a manual Quality-menu pick.
 * Fixed height: disable player-size cap + ABR, force start/load/current level.
 * Auto: keep ABR capped at HLS_AUTO_MAX_HEIGHT for proxy-friendly starts.
 * Returns store quality index (-1 = auto).
 */
/**
 * Force a fixed quality rung (same path as the Quality menu click).
 * Returns store quality index, or -1 if no levels.
 */
function forceHlsLevel(hls: Hls, levelIndex: number): number {
  if (levelIndex < 0) return -1;
  hls.capLevelToPlayerSize = false;
  hls.autoLevelCapping = -1;
  // Startup-only selection: hls.js has not loaded a media fragment yet.
  // loadLevel owns the fixed preference without the full-buffer flush caused
  // by currentLevel. Live switches use switchHlsLevelSmooth instead.
  hls.startLevel = levelIndex;
  hls.loadLevel = levelIndex;
  hls.nextLoadLevel = levelIndex;
  return levelIndex;
}

function isInteractivePlayerTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button,a,input,select,textarea,[role='button'],[role='slider'],[role='dialog'],[role='alertdialog']"
      )
    )
  );
}

/**
 * Manual mid-play switch without `currentLevel`: keep the decoded buffer and
 * move as soon as the current fragment boundary permits. hls.js `nextLevel`
 * aborts obsolete loading and flushes only forward buffer outside the playing
 * fragment; `loadLevel` alone deliberately waits behind the entire buffered
 * window (up to 30 seconds here), which made an explicit quality click look
 * broken. This keeps the playhead continuous without the hard interruption of
 * `currentLevel`.
 */
function switchHlsLevelSmooth(hls: Hls, levelIndex: number): number {
  if (levelIndex < 0) return -1;
  hls.capLevelToPlayerSize = false;
  hls.autoLevelCapping = -1;
  hls.nextLevel = levelIndex;
  return levelIndex;
}

/**
 * Always force ≥1080 immediately. "Auto" = ABR only among 1080/1440/4K, never below.
 */
function applyPreferredHlsQuality(
  hls: Hls,
  levels: QualityLevel[],
  prefRaw: PlayerQualityTarget = getPreferredQualityHeight()
): number {
  if (!levels.length) return -1;
  const prefHeight = prefRaw === "auto" ? HLS_TARGET_HEIGHT : prefRaw;

  hls.capLevelToPlayerSize = false;

  if (prefRaw === "auto") {
    // Manual level stays -1 so ABR can climb to 1440/4K. Seed only the first
    // Auto fragment at the lowest >=1080 (never absolute max / 4K default).
    // Floor enforcement mid-play uses nextLevel in LEVEL_SWITCHING (smooth,
    // non-flushing) — never currentLevel unless a fixed user pick requires it.
    hls.autoLevelCapping = -1;
    hls.capLevelToPlayerSize = false;
    // Release a previous fixed menu/profile selection without currentLevel's
    // destructive flush. This restores manualLevel=-1 before seeding the next
    // Auto fragment; otherwise the UI could say Auto while hls.js stayed pinned.
    const defaultIdx = pickDefaultQualityIndex(levels);
    const idx = defaultIdx >= 0 ? defaultIdx : findBestLevelForTarget(levels, HLS_MIN_HEIGHT);
    if (idx >= 0) {
      hls.startLevel = idx;
      seedNextAutoLevel(hls, idx);
    } else {
      hls.loadLevel = -1;
    }
    return -1;
  }

  const targetH = prefHeight;
  let idx = findBestLevelForTarget(levels, targetH);
  // Sub-HD-only ladder (pickDefaultQualityIndex = -1): still force best available.
  if (idx < 0) idx = findMinLevelIndexForHeight(levels, 0);
  if (idx < 0) idx = pickStartLevelIndex(levels);
  return forceHlsLevel(hls, idx);
}

/**
 * If playback ever dips below 1080 (e.g. a brief ABR misfire before the
 * LEVEL_SWITCHING/LEVEL_SWITCHED guards catch it), snap back to the floor —
 * UNLESS the adaptive policy is active AND we're currently starving (buffer
 * until the forward buffer has recovered, in which case the downshift is
 * intentional and we let it hold (recoverHlsAdaptive handles the climb).
 *
 * For the "absolute" policy this always snaps back unconditionally (the old
 * brand behavior). bufferAheadS < 0 (unknown) is treated as not-starving so the
 * default path preserves the original snap-back for callers without buffer info.
 */
function maybePromoteHlsQuality(
  hls: Hls,
  levels: QualityLevel[],
  video: HTMLVideoElement,
  preferredHeight: PlayerQualityTarget = getPreferredQualityHeight()
): number | null {
  if (!levels.length) return null;
  const targetH = hlsPromotionTargetHeight(
    levels,
    preferredHeight,
    HLS_MIN_HEIGHT
  );
  // Auto on a sub-HD-only ladder has no 1080 floor to enforce. Let ABR own it.
  if (targetH == null) return null;
  const curIdx = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
  const cur = levels.find((l) => l.index === curIdx);
  const curH = cur ? effectiveLevelHeight(cur) : 0;
  if (curH >= targetH * 0.95) return null;

  // Adaptive + actively starving → let the downshift breathe (don't snap back).
  const policy = getQualityFloorPolicySafe();
  const bufferAheadS = bufferedAheadSeconds(video);
  if (
    preferredHeight === "auto" &&
    policy === "adaptive" &&
    bufferAheadS < ADAPTIVE_CLIMB_BUFFER_SECONDS
  ) {
    return null;
  }

  const idx = findBestLevelForTarget(levels, targetH);
  if (idx < 0 || idx === curIdx) return null;
  hls.autoLevelCapping = -1;
  if (preferredHeight === "auto") {
    // One-fragment Auto hint: no manual pin and no currentLevel flush. hls.js
    // clears forcedAutoLevel after that fragment is loaded.
    seedNextAutoLevel(hls, idx);
    return idx;
  }
  return switchHlsLevelSmooth(hls, idx);
}

/** Forward-buffer health in seconds from the <video> element's buffered ranges. */
function bufferedAheadSeconds(video: HTMLVideoElement): number {
  try {
    const t = video.currentTime;
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (t >= start && t <= end) return Math.max(0, end - t);
      if (t < start) return 0;
    }
    return ranges.length ? Math.max(0, ranges.end(ranges.length - 1) - t) : 0;
  } catch {
    return -1;
  }
}

function mapDashLevels(player: MediaPlayerClass): QualityLevel[] {
  const bitrateList = player.getBitrateInfoListFor("video") ?? [];
  return bitrateList.map((info) => ({
    height: info.height,
    width: info.width,
    index: info.qualityIndex,
    bitrate: info.bitrate,
  }));
}

/**
 * Lowest bitrate (kbps — dash.js's abr.minBitrate/initialBitrate unit) among
 * levels meeting minHeight. Gives dash.js's own ABR a 1080 floor hint so Auto
 * doesn't start (or settle) at the bottom of the ladder — parity with the
 * hls.js floor. dash.js's minBitrate is a soft preference, not a hard clamp,
 * so genuine starvation can still ride below it (no separate relax needed).
 */
function findDashFloorBitrateKbps(levels: QualityLevel[], minHeight: number): number {
  let best = -1;
  for (const level of levels) {
    const h = effectiveLevelHeight(level);
    if (h < minHeight) continue;
    const bitrate = level.bitrate ?? 0;
    if (bitrate > 0 && (best < 0 || bitrate < best)) best = bitrate;
  }
  return best > 0 ? Math.round(best / 1000) : 0;
}

function pickPreferredAudioId(hls: Hls): number {
  const pref = getPreferredAudioLanguage().toLowerCase();
  const match = hls.audioTracks.find((t) => {
    const lang = (t.lang ?? "").toLowerCase();
    const name = (t.name ?? "").toLowerCase();
    if (pref === "en" || pref.startsWith("en")) {
      return isEnglishTrack(t.lang, t.name);
    }
    return lang.startsWith(pref) || name.includes(pref);
  });
  if (match) return typeof match.id === "number" ? match.id : hls.audioTracks.indexOf(match);
  const first = hls.audioTracks[0];
  if (first && typeof first.id === "number") return first.id;
  return 0;
}

function hlsHasTrackId(
  tracks: Array<{ id?: number }>,
  trackId: number
): boolean {
  return tracks.some((t, i) => (typeof t.id === "number" ? t.id : i) === trackId);
}

export function VideoPlayer({
  sources,
  sourcesLoading,
  sourcesError,
  onRetrySources,
  isDiscoveringSources,
  profileQuality,
  refreshNonce,
  sourceCount = 0,
  poster,
  title,
  mediaType,
  tmdbId,
  initialTime,
  onProgress,
  onEnded,
  hasNextEpisode,
  onNextEpisode,
  nextEpisodeTarget = null,
  onBack,
  tvId,
  tvSeasons,
  tvSeason,
  tvEpisode,
  onSelectEpisode,
}: Props) {
  const [activeSource, setActiveSource] = useState<PlaybackSource | null>(null);
  const [sourceReloadGeneration, setSourceReloadGeneration] = useState(0);
  const orderedSources = useMemo(() => {
    // This is the single player-facing roster. Conclusively dead, rejected,
    // poisoned, or browser-incompatible rows never reach initial selection,
    // failover, discovery state, or the visible server/quality controls.
    // Unprobed clean rows remain eligible and are shown with neutral health.
    const deduped = dedupePlaybackSources(sources);
    return sortSourcesForPicker(eligiblePlaybackSources(deduped));
  }, [sources]);
  const [failedSourceIds, setFailedSourceIds] = useState<string[]>([]);
  const failedSourceIdsRef = useRef<Set<string>>(new Set());
  const resumeAtRef = useRef(0);
  const initialTimeAppliedRef = useRef(false);
  const prevSourceCount = useRef(0);
  /** User picked a server in the dock/settings — never auto-upgrade over that. */
  const userSelectedSourceRef = useRef(false);
  /** A per-watch quality click wins over a later progressive profile response. */
  const userSelectedQualityRef = useRef(false);
  /** At most one Luna→fast CDN auto-upgrade per watch session (pre-first-frame). */
  const autoUpgradedRef = useRef(false);
  /**
   * One-shot "adopt a refreshed URL for the currently-active source id" flag.
   * Armed by the session-expired (410) retry path and the "Retry full" button —
   * both re-fetch the roster expecting the SAME logical source to come back
   * with a renewed signed URL. Without this, the orderedSources-reconciliation
   * effect below refuses to touch `activeSource` once `everPlayedRef`/
   * `userSelectedSourceRef` are set (its "don't thrash sources after first
   * play" policy), so the player kept silently re-requesting the dead/expired
   * URL forever — the exact retry path meant to fix it never actually took
   * effect. Consumed (cleared) the first time a genuinely different URL for
   * the same id is observed; otherwise stays armed and harmless.
   */
  const pendingUrlRefreshRef = useRef(false);
  /** One automatic cache-bypassing roster refresh per title session. */
  const automaticRosterRefreshRef = useRef(false);
  /**
   * First healthy decode landed — full-screen hunting overlay never returns.
   * Pre-play CDN auto-upgrade is also frozen after this.
   */
  const everPlayedRef = useRef(false);
  const [everPlayed, setEverPlayed] = useState(false);
  /** True only after intentional user pause — do not auto-resume after underrun. */
  const userPausedRef = useRef(false);
  /** Separates native PiP user pauses from pause events caused by engine teardown. */
  const pauseIntentControllerRef = useRef(new MediaPauseIntentController());
  /** Terminal UI blocks delayed canplay/play events until an explicit retry. */
  const terminalBlockedRef = useRef(false);
  /** Mid-watch source switch / failover — compact chip only, keep last frame. */
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);
  /** One-shot status after hard-error auto-failover (not silent stalls). */
  const [failoverNotice, setFailoverNotice] = useState<string | null>(null);
  const failoverNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Source ids already observed this title session — growth triggers the
   * non-blocking "New source available" nudge (never auto-switches).
   */
  const seenSourceIdsRef = useRef<Set<string>>(new Set());
  const [newSourceNotice, setNewSourceNotice] = useState(false);
  const newSourceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One-shot "Resuming from mm:ss" toast — fires when a continue-watching seek lands. */
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const resumeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Confirmed decode height per source id (MP4/native loadedmetadata) so the
   * dock badge can show honest resolution without mutating props.
   */
  const [detectedHeights, setDetectedHeights] = useState<Record<string, number>>({});
  /**
   * Client-side background health probe results, keyed by source id — fills
   * the Server list's health dot for sources the server-side full-scrape
   * probe never covered. Never overwrites a server-measured probe (see
   * withClientHealthProbe) and never influences auto-selection.
   */
  const [probedHealth, setProbedHealth] = useState<Record<string, SourceProbeMetrics>>({});
  const probeInFlightRef = useRef<Set<string>>(new Set());
  /** Roster with MP4/native decode heights + background health merged for dock badges. */
  const displaySources = useMemo(() => {
    if (!Object.keys(detectedHeights).length && !Object.keys(probedHealth).length) {
      return orderedSources;
    }
    return orderedSources.map((s) => {
      let next = s;
      const h = detectedHeights[s.id];
      if (h && h > 0) next = withDetectedSourceHeight(next, h);
      const probe = probedHealth[s.id];
      if (probe) next = withClientHealthProbe(next, probe);
      return next;
    });
  }, [orderedSources, detectedHeights, probedHealth]);
  const lastTimeUpdateRef = useRef(0);
  const [autoplayHint, setAutoplayHint] = useState<string | null>(null);
  const [levelsPending, setLevelsPending] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockSection, setDockSection] = useState<DockSection | null>(null);
  /** Per-watch selection, initialized from (but never written back to) the profile default. */
  const [qualityTarget, setQualityTarget] = useState<PlayerQualityTarget>(
    () => profileQuality ?? getPreferredQualityHeight()
  );
  const qualityTargetRef = useRef<PlayerQualityTarget>(qualityTarget);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [swipeHint, setSwipeHint] = useState<"hidden" | "visible" | "fading">("hidden");
  const swipeHintShownRef = useRef(false);
  /** Sleep timer minutes; null = off. Implemented here so pause actually fires. */
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Honest "N sources" count for the hunting overlay — excludes hard-failed
   * (this session) and soft-kept/probe-failed rows. A dead/soft-failed
   * source must never inflate the number the owner sees while it's still
   * "Finding sources…".
   */
  const healthySourceCount = useMemo(
    () => eligiblePlaybackSources(orderedSources, new Set(failedSourceIds)).length,
    [orderedSources, failedSourceIds]
  );
  const src = activeSource?.url ?? "";
  const streamType = activeSource?.type ?? "hls";
  // Transcode routing: if the active source can't play natively in THIS
  // browser (HEVC/AV1 it can't decode, or ANY MKV/WebM container — no
  // browser plays those directly), hand it to the in-container transcoder
  // (AMD VAAPI h264_vaapi → H.264 HLS) so it plays anyway. Natively-playable
  // sources play direct (zero transcode cost). Safari/HW-Chrome never hit this
  // for HEVC/AV1; MKV/WebM ALWAYS hits it, on every browser.
  const needsTranscode = !!activeSource && !isSourcePlayableHere(activeSource);
  // Transcode target policy: live 4K transcoding on the shared VAAPI encoder
  // is too slow-starting to be viable (see mini-services/transcoder header —
  // measured ~0.9x realtime at 4K vs ~3.3x at 1080p) — always cap the
  // requested ladder at TRANSCODE_MAX_HEIGHT so a 4K HEVC/MKV source becomes
  // a smooth, fast-starting 1080p H.264 ABR ladder instead. Real 4K only
  // ever happens on the native-decode path (this branch is never taken for
  // it). Shares the same constant as source-quality.ts's badge cap so the
  // UI's quality claim can never drift from what's actually encoded.
  const transcodeMaxHeight =
    needsTranscode && activeSource
      ? Math.min(activeSource.maxHeight || TRANSCODE_MAX_HEIGHT, TRANSCODE_MAX_HEIGHT)
      : TRANSCODE_MAX_HEIGHT;
  const transcodeUrl =
    needsTranscode && tmdbId && activeSource
      ? `/api/transcode?type=${mediaType ?? "movie"}&id=${tmdbId}` +
        `&sourceId=${encodeURIComponent(activeSource.id)}` +
        `&maxHeight=${transcodeMaxHeight}` +
        (mediaType === "tv" && tvSeason && tvEpisode
          ? `&season=${tvSeason}&episode=${tvEpisode}`
          : "")
      : "";
  const effectiveSrc = needsTranscode && transcodeUrl ? transcodeUrl : src;
  const effectiveStreamType = needsTranscode && transcodeUrl ? "hls" : streamType;
  // Play as soon as we have a source URL — never wait for scrape enrichment.
  const hasStream = !!src;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<MediaPlayerClass | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastProgressSave = useRef(0);
  const firstProgressSavedRef = useRef(false);
  /** Fire-once next-episode source preresolve at 80% progress. */
  const nextEpPreloadedRef = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const touchStartedOnInteractive = useRef(false);

  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const buffering = usePlayerStore((s) => s.buffering);
  const showControls = usePlayerStore((s) => s.showControls);
  const error = usePlayerStore((s) => s.error);
  /** Honest current rung for the "Buffering — Xp" chip (task 2) — rarely
   * changes (only on LEVEL_SWITCHED/QUALITY_CHANGE_RENDERED), safe to
   * subscribe directly without the ref-bypass pattern used for bufferedEnd. */
  const playingHeight = usePlayerStore((s) => s.playingHeight);
  const subtitlesOn = usePlayerStore((s) => s.subtitlesOn);
  const activeSubtitleId = usePlayerStore((s) => s.activeSubtitleId);

  const huntingName = activeSource
    ? getServerDisplayName(activeSource.provider, activeSource.label, activeSource.id)
    : "servers";
  // CRITICAL: overlay is gated on firstPlayable (hasStream), NOT scrape complete.
  const needsSourceHunt =
    sourcesLoading || (!hasStream && !sourcesError && !orderedSources.length);
  /**
   * One continuous full-bleed overlay for the whole pre-first-frame journey —
   * "finding sources" → "connecting to <server>" → "buffering" — instead of
   * the old design where the big poster/title card vanished the instant a
   * source was picked, replaced by the bare video element + a small top pill.
   * That swap was exactly the kind of layout jump/flicker a real streaming
   * service never shows; keeping ONE treatment up (only the status text
   * changes) until `everPlayed` removes the jump entirely.
   */
  const showHunting =
    !error &&
    !sourcesError &&
    !everPlayed &&
    (needsSourceHunt || (hasStream && buffering));
  /**
   * Staged, honest status text for the overlay above. `undefined` while
   * still hunting (no source picked yet) lets LoadingScreen's own
   * "Finding sources… (N found)" rotation run; once a source is picked we
   * take over with an explicit stage so it never regresses to vague "Found N
   * sources" copy while we're actually waiting on ONE specific connection.
   * `levelsPending` (cleared at MANIFEST_PARSED/STREAM_INITIALIZED) is the
   * real "have we connected yet" signal — distinct from `buffering`, which
   * only says "no frame yet" and stays true a little past that point too.
   */
  const loadingStatus: string | null = !hasStream
    ? null
    : needsTranscode
      ? "Preparing stream…"
      : levelsPending
        ? huntingName && huntingName !== "servers"
          ? `Connecting to ${huntingName}…`
          : "Connecting…"
        : "Buffering…";
  const showSwitchingChip =
    !error &&
    everPlayed &&
    isSwitchingServer &&
    buffering &&
    hasStream;
  /** Mid-playback stall chip (after first frame). */
  const showBufferingChip =
    !error &&
    everPlayed &&
    buffering &&
    hasStream &&
    !isSwitchingServer &&
    !failoverNotice;

  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setBuffering = usePlayerStore((s) => s.setBuffering);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setIsMuted = usePlayerStore((s) => s.setIsMuted);
  const setIsFullscreen = usePlayerStore((s) => s.setIsFullscreen);
  const setIsPip = usePlayerStore((s) => s.setIsPip);
  const setShowControls = usePlayerStore((s) => s.setShowControls);
  const setQuality = usePlayerStore((s) => s.setQuality);
  const setPlayingHeight = usePlayerStore((s) => s.setPlayingHeight);
  const setLevels = usePlayerStore((s) => s.setLevels);
  // Setter only (stable reference) — VideoPlayer never subscribes to the value
  // itself, so the ~4x/sec buffered-edge tick no longer re-renders this tree.
  const setBufferedEnd = usePlayerStore((s) => s.setBufferedEnd);
  const setSpeed = usePlayerStore((s) => s.setSpeed);
  const setSubtitlesOn = usePlayerStore((s) => s.setSubtitlesOn);
  const setError = usePlayerStore((s) => s.setError);
  const setSubtitleTracks = usePlayerStore((s) => s.setSubtitleTracks);
  const setAudioTracks = usePlayerStore((s) => s.setAudioTracks);
  const setActiveSubtitleId = usePlayerStore((s) => s.setActiveSubtitleId);
  const setActiveAudioId = usePlayerStore((s) => s.setActiveAudioId);
  const setServerDisplayName = usePlayerStore((s) => s.setServerDisplayName);
  const resetStream = usePlayerStore((s) => s.resetStream);

  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;
  /** Stable roster snapshot — failActiveSource must not change identity on enrich. */
  const orderedSourcesRef = useRef(orderedSources);
  orderedSourcesRef.current = orderedSources;
  /** hls.js levels with ladder/maxHeight annotation from source metadata. */
  const levelsFromHls = useCallback((hls: Hls): QualityLevel[] => {
    const src = activeSourceRef.current;
    const fallback = src ? sourceMaxHeight(src) : 0;
    const ladder = src?.ladder ?? [];
    return mapHlsLevels(hls, fallback, ladder);
  }, []);
  const tryNextSourceRef = useRef<() => boolean>(() => false);
  const onRetrySourcesRef = useRef(onRetrySources);
  onRetrySourcesRef.current = onRetrySources;
  /** While full enrich is still adding servers, never hard-fail the watch shell. */
  const isDiscoveringRef = useRef(false);
  isDiscoveringRef.current = Boolean(isDiscoveringSources);
  const dockOpenRef = useRef(false);
  const shortcutsOpenRef = useRef(false);
  dockOpenRef.current = dockOpen;
  shortcutsOpenRef.current = shortcutsOpen;
  const networkRecoveriesRef = useRef(0);
  const sessionRefreshRef = useRef<{
    attempt: SourceAttemptToken;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const lastStallRecoverAtRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * One controller owns source identity and terminal-failure arbitration for
   * every media engine. It prevents a late callback from a destroyed engine
   * from failing whichever source happens to be current now.
   */
  const sourceAttemptControllerRef = useRef(new SourceAttemptController());
  const clearSessionRefresh = useCallback(
    (attempt?: SourceAttemptToken): boolean => {
      const owner = sessionRefreshRef.current;
      if (!owner) return false;
      if (
        attempt &&
        (owner.attempt.generation !== attempt.generation ||
          owner.attempt.sourceId !== attempt.sourceId)
      ) {
        return false;
      }
      clearTimeout(owner.timer);
      sessionRefreshRef.current = null;
      return true;
    },
    []
  );
  const invalidateSourceAttempt = useCallback(() => {
    sourceAttemptControllerRef.current.invalidate();
  }, []);
  /** Engine-agnostic playhead watchdog baseline. The controller permits one
   * recovery window before a still-dead attempt becomes terminal. */
  const stallWatchdogBaselineRef = useRef<{ t: number; pos: number }>({ t: 0, pos: 0 });
  /**
   * User's caption intent (on/off + language), independent of the per-stream
   * store fields that resetStream() clears on every source switch — without
   * this, captions silently turned off on every server change.
   */
  const subtitleIntentRef = useRef<{ on: boolean; lang: string | null }>({
    on: false,
    lang: null,
  });
  /** Latest onProgress/onEnded/nextEpisodeTarget — read via ref inside the media
   * listener effect so a new prop identity never forces a full listener re-attach. */
  const onProgressRef = useRef(onProgress);
  const onEndedRef = useRef(onEnded);
  const nextEpisodeTargetRef = useRef(nextEpisodeTarget);
  useEffect(() => {
    onProgressRef.current = onProgress;
    onEndedRef.current = onEnded;
    nextEpisodeTargetRef.current = nextEpisodeTarget;
  });

  const markEverPlayed = useCallback(() => {
    if (everPlayedRef.current) return;
    everPlayedRef.current = true;
    setEverPlayed(true);
    setIsSwitchingServer(false);
  }, []);

  const requestAutomaticRosterRefresh = useCallback((): boolean => {
    if (
      automaticRosterRefreshRef.current ||
      !onRetrySourcesRef.current
    ) {
      return false;
    }
    automaticRosterRefreshRef.current = true;
    pendingUrlRefreshRef.current = true;
    setError(null);
    setBuffering(true);
    if (everPlayedRef.current) setIsSwitchingServer(true);
    onRetrySourcesRef.current();
    return true;
  }, [setBuffering, setError]);

  useEffect(() => {
    return () => {
      usePlayerStore.getState().reset();
      // These three notice timers are only ever cleared on title switch (the
      // mediaKey effect below) — a full unmount (navigating away mid-notice)
      // previously left them running, each firing a stray setState against an
      // already-unmounted component a few seconds later.
      if (failoverNoticeTimerRef.current) clearTimeout(failoverNoticeTimerRef.current);
      if (newSourceNoticeTimerRef.current) clearTimeout(newSourceNoticeTimerRef.current);
      if (resumeNoticeTimerRef.current) clearTimeout(resumeNoticeTimerRef.current);
      clearSessionRefresh();
    };
  }, [clearSessionRefresh]);

  /** Episode/title identity — reset session flags so next title never inherits resume/source state. */
  const mediaKey = `${mediaType ?? "movie"}:${tmdbId ?? tvId ?? title}:${tvSeason ?? ""}:${tvEpisode ?? ""}`;

  useEffect(() => {
    invalidateSourceAttempt();
    sourceAttemptControllerRef.current.resetRefreshBudget();
    failedSourceIdsRef.current.clear();
    setFailedSourceIds([]);
    userSelectedSourceRef.current = false;
    userSelectedQualityRef.current = false;
    autoUpgradedRef.current = false;
    everPlayedRef.current = false;
    firstProgressSavedRef.current = false;
    userPausedRef.current = false;
    terminalBlockedRef.current = false;
    initialTimeAppliedRef.current = false;
    subtitleIntentRef.current = { on: false, lang: null };
    seenSourceIdsRef.current = new Set();
    // Always start the new title/episode at 0 unless continue-watching seeds initialTime.
    resumeAtRef.current = 0;
    setCurrentTime(0);
    setEverPlayed(false);
    setIsSwitchingServer(false);
    setActiveSource(null);
    setError(null);
    setSleepMinutes(null);
    setAutoplayHint(null);
    const initialQuality = profileQuality ?? getPreferredQualityHeight();
    qualityTargetRef.current = initialQuality;
    setQualityTarget(initialQuality);
    setFailoverNotice(null);
    setNewSourceNotice(false);
    setResumeNotice(null);
    setDetectedHeights({});
    setProbedHealth({});
    probeInFlightRef.current.clear();
    pendingUrlRefreshRef.current = false;
    automaticRosterRefreshRef.current = false;
    clearSessionRefresh();
    if (failoverNoticeTimerRef.current) {
      clearTimeout(failoverNoticeTimerRef.current);
      failoverNoticeTimerRef.current = null;
    }
    if (newSourceNoticeTimerRef.current) {
      clearTimeout(newSourceNoticeTimerRef.current);
      newSourceNoticeTimerRef.current = null;
    }
    if (resumeNoticeTimerRef.current) {
      clearTimeout(resumeNoticeTimerRef.current);
      resumeNoticeTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity change only
  }, [
    mediaKey,
    setCurrentTime,
    setError,
    invalidateSourceAttempt,
    clearSessionRefresh,
  ]);

  useEffect(() => {
    if (refreshNonce == null) return;
    // The response is a newly scraped roster. Re-arm every logical source ID
    // because its signed URL may have changed even when the stable ID did not.
    failedSourceIdsRef.current.clear();
    pendingUrlRefreshRef.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setFailedSourceIds([]);
      setError(null);
      setBuffering(true);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, setBuffering, setError]);

  useEffect(() => {
    if (!orderedSources.length) {
      invalidateSourceAttempt();
      setActiveSource(null);
      setBuffering(false);
      return;
    }
    const decodedVideo = videoRef.current;
    if (
      !everPlayedRef.current &&
      decodedVideo &&
      decodedVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      decodedVideo.videoWidth > 0
    ) {
      // Progressive enrichment can resolve in the same render window as the
      // first decoded frame. The `playing` listener normally owns this lock,
      // but this synchronous guard closes the race before a higher-labelled
      // late source can tear down video the user is already watching.
      markEverPlayed();
      return;
    }
    const stillValid = activeSource && orderedSources.some((s) => s.id === activeSource.id);
    const activeFailed =
      !!activeSource && failedSourceIdsRef.current.has(activeSource.id);

    // Refreshed URL for the SAME logical source (session-expired retry / "Try
    // again" re-fetch landed) — always adopt it, bypassing the userSelected/
    // everPlayed/autoUpgraded lockouts below. This is not a source SWITCH, it's
    // the current source catching up to a renewed signed URL; refusing it here
    // is what left the player silently re-requesting a dead 410 link forever.
    if (stillValid && activeSource && pendingUrlRefreshRef.current) {
      const refreshed = orderedSources.find((s) => s.id === activeSource.id);
      if (refreshed) {
        invalidateSourceAttempt();
        pendingUrlRefreshRef.current = false;
        // Preserve playhead — the dying/expired stream still reflects where the
        // owner was; without capturing it the fresh hls.js instance restarts at 0.
        const t = videoRef.current?.currentTime ?? 0;
        if (t > RESUME_CAPTURE_MIN_S) resumeAtRef.current = t;
        initialTimeAppliedRef.current = false;
        setActiveSource(refreshed);
        if (refreshed.url === activeSource.url) {
          // A transient origin failure can recover without changing its URL.
          // Force a new media attempt instead of leaving the errored element
          // mounted under the same React identity.
          setSourceReloadGeneration((generation) => generation + 1);
        }
        return;
      }
    }

    // Before first frame: allow re-pick when enrich surfaces a better multi-rung
    // (or higher) source. After first healthy play, sticky unless active failed.
    const preferred = getPreferredProvider();
    const preferredHeight = qualityTargetRef.current;
    const pool = eligiblePlaybackSources(
      orderedSources,
      failedSourceIdsRef.current
    );
    const best = pickDefaultSource(pool, preferred, preferredHeight);

    if (stillValid && !activeFailed && activeSource && best) {
      if (userSelectedSourceRef.current || everPlayedRef.current || autoUpgradedRef.current) {
        return;
      }
      // Cold start only: jump to multi-rung / better ranked source before first frame.
      if (best.id === activeSource.id) return;
      const betterMulti =
        isMultiRendition(best) && !isMultiRendition(activeSource);
      const betterHeight =
        sourceMaxHeight(best) > sourceMaxHeight(activeSource) + 100;
      if (!betterMulti && !betterHeight) return;
      autoUpgradedRef.current = true;
      initialTimeAppliedRef.current = false;
      setError(null);
      invalidateSourceAttempt();
      setActiveSource(best);
      setBuffering(true);
      return;
    }

    // Re-pick when missing, dropped from list, or failed while better sources exist.
    if (!stillValid || (activeFailed && !userSelectedSourceRef.current)) {
      if (best && best.id !== activeSource?.id) {
        const t = videoRef.current?.currentTime ?? 0;
        if (t > RESUME_CAPTURE_MIN_S) {
          resumeAtRef.current = t;
        }
        initialTimeAppliedRef.current = false;
        setError(null);
        invalidateSourceAttempt();
        setActiveSource(best);
        setBuffering(true);
      }
    }
  }, [
    orderedSources,
    activeSource,
    setBuffering,
    setError,
    invalidateSourceAttempt,
    markEverPlayed,
  ]);

  /**
   * Discovery-closed re-arm (task 2): nothing previously re-evaluated the
   * hunting spinner once background discovery finished — if every known
   * source had already failed while discovery was still open, the player
   * sat on "Finding sources…" forever. Grace period lets any last-second
   * source additions land before we give up and surface Retry.
   *
   * Also covers the zero-sources case (bug fix): the original version bailed
   * out entirely when `orderedSources.length === 0` on the theory that the
   * parent's `sourcesError` path would handle it — but a title that finishes
   * loading with genuinely zero sources and no explicit error/discovery flag
   * (a real, reachable state, not hypothetical) left the "Finding sources…"
   * overlay spinning forever with no error, no retry, no escape. `hasStream`
   * is also checked, since `activeSource` is null the whole time in this
   * branch (no `state.buffering` gate needed — nothing ever streams to flip
   * buffering true here).
   */
  useEffect(() => {
    if (isDiscoveringSources || sourcesLoading) return;
    const timer = setTimeout(() => {
      const state = usePlayerStore.getState();
      if (state.error) return;
      if (orderedSources.length === 0) {
        // The dedicated sourcesError card (parent fetch failure) already
        // owns this screen — don't layer a second full-bleed card on top.
        if (hasStream || sourcesError) return;
        if (requestAutomaticRosterRefresh()) return;
        setBuffering(false);
        setError(ALL_SOURCES_FAILED_MSG);
        return;
      }
      const allFailed = orderedSources.every((s) => failedSourceIdsRef.current.has(s.id));
      if (!allFailed || !state.buffering) return;
      if (requestAutomaticRosterRefresh()) return;
      setBuffering(false);
      setError(ALL_SOURCES_FAILED_MSG);
    }, DISCOVERY_CLOSED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [
    isDiscoveringSources,
    sourcesLoading,
    orderedSources,
    hasStream,
    sourcesError,
    setBuffering,
    setError,
    requestAutomaticRosterRefresh,
  ]);

  useEffect(() => {
    const count = orderedSources.length;
    if (count > prevSourceCount.current && prevSourceCount.current > 0 && hasStream) {
      setShowControls(true);
    }
    prevSourceCount.current = count;
  }, [orderedSources.length, hasStream, setShowControls]);

  useEffect(() => {
    if (!hasStream) setBuffering(false);
  }, [hasStream, setBuffering]);

  useEffect(() => {
    if (!hasStream || swipeHintShownRef.current) return;
    if (typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches) return;
    swipeHintShownRef.current = true;
    setSwipeHint("visible");
    const fadeTimer = setTimeout(() => setSwipeHint("fading"), SWIPE_HINT_VISIBLE_MS);
    const hideTimer = setTimeout(() => setSwipeHint("hidden"), SWIPE_HINT_VISIBLE_MS + SWIPE_HINT_FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [hasStream]);

  useEffect(() => {
    if (activeSource) {
      setServerDisplayName(
        getServerDisplayName(activeSource.provider, activeSource.label, activeSource.id)
      );
    }
  }, [activeSource, setServerDisplayName]);

  const syncHlsTracks = useCallback(
    (hls: Hls) => {
      const audio = mapAudioTracks(hls);
      const subs = mapSubtitleTracks(hls);
      setAudioTracks(audio);
      setSubtitleTracks(subs);

      if (audio.length > 0) {
        const audioId = pickPreferredAudioId(hls);
        hls.audioTrack = audioId;
        setActiveAudioId(audioId);
      }

      // Re-apply the user's persisted caption intent — NOT the store's
      // subtitlesOn/activeSubtitleId, which resetStream() just wiped for this
      // new source. Reading the store here would always see "off" right after
      // a server switch, which was the "captions silently turn off" bug.
      if (subs.length > 0 && subtitleIntentRef.current.on) {
        const wantLang = subtitleIntentRef.current.lang;
        const matched =
          (wantLang && subs.find((t) => (t.lang ?? "").toLowerCase() === wantLang.toLowerCase())) ||
          subs.find((t) => isEnglishTrack(t.lang, t.name)) ||
          subs[0];
        hls.subtitleTrack = matched.id;
        hls.subtitleDisplay = true;
        setActiveSubtitleId(matched.id);
        setSubtitlesOn(true);
      } else {
        hls.subtitleTrack = -1;
        hls.subtitleDisplay = false;
        setSubtitlesOn(false);
        setActiveSubtitleId(null);
      }
    },
    [setAudioTracks, setSubtitleTracks, setActiveAudioId, setActiveSubtitleId, setSubtitlesOn]
  );

  const syncNativeTracks = useCallback(
    (video: HTMLVideoElement) => {
      const audio = mapNativeAudioTracks(video);
      const subs = mapNativeTextTracks(video);
      setAudioTracks(audio);
      setSubtitleTracks(subs);
      if (audio.length > 0) {
        const pref = getPreferredAudioLanguage().toLowerCase();
        const match =
          audio.find((t) =>
            pref === "en" || pref.startsWith("en")
              ? isEnglishTrack(t.lang, t.name)
              : (t.lang ?? "").toLowerCase().startsWith(pref) ||
                t.name.toLowerCase().includes(pref)
          ) ?? audio[0];
        setActiveAudioId(match.id);
        const media = video as HTMLVideoElement & {
          audioTracks?: { length: number; [i: number]: { enabled?: boolean } };
        };
        const list = media.audioTracks;
        if (list) {
          for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (t) t.enabled = i === match.id;
          }
        }
      }
      // Re-apply persisted caption intent (see syncHlsTracks) instead of
      // always defaulting off — same fix for the Safari native-HLS path.
      let matchedId: number | null = null;
      if (subtitleIntentRef.current.on && subs.length > 0) {
        const wantLang = subtitleIntentRef.current.lang;
        const matched =
          (wantLang && subs.find((t) => (t.lang ?? "").toLowerCase() === wantLang.toLowerCase())) ||
          subs.find((t) => isEnglishTrack(t.lang, t.name)) ||
          subs[0];
        matchedId = matched.id;
      }
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (t && (t.kind === "subtitles" || t.kind === "captions")) {
          t.mode = i === matchedId ? "showing" : "disabled";
        }
      }
      if (matchedId !== null) {
        setActiveSubtitleId(matchedId);
        setSubtitlesOn(true);
      } else {
        setSubtitlesOn(false);
        setActiveSubtitleId(null);
      }
    },
    [setAudioTracks, setSubtitleTracks, setActiveAudioId, setActiveSubtitleId, setSubtitlesOn]
  );

  const markSourceFailed = useCallback((sourceId: string) => {
    if (failedSourceIdsRef.current.has(sourceId)) return;
    failedSourceIdsRef.current.add(sourceId);
    setFailedSourceIds((prev) => [...prev, sourceId]);
  }, []);

  const handleSourceChange = useCallback(
    (source: PlaybackSource, opts?: { userPick?: boolean }) => {
      // Always operate on the clean, server-data-only source. The Server list
      // renders `displaySources`, which may carry a coarse CLIENT-measured probe
      // (withClientHealthProbe); that must never become `activeSource.probe`,
      // where ranking/upgrade logic reads `.probe` as authoritative server data.
      // Re-resolve by id against `orderedSources` (never client-probe-augmented).
      const resolved = orderedSourcesRef.current.find((s) => s.id === source.id) ?? source;
      const video = videoRef.current;
      const current = activeSourceRef.current;
      const sameMediaIdentity =
        current?.id === resolved.id && current.url === resolved.url;
      const sameSourceHealthy =
        sameMediaIdentity &&
        !failedSourceIdsRef.current.has(resolved.id) &&
        !video?.error;
      if (sameSourceHealthy) {
        // Clicking the already-live row may refresh metadata/preference, but
        // must not invalidate its generation token. With unchanged id+URL
        // React intentionally keeps the engine mounted, so invalidation here
        // used to leave the next real media error permanently ownerless.
        setActiveSource(resolved);
        if (opts?.userPick) setPreferredProvider(preferenceKey(resolved));
        setServerDisplayName(
          getServerDisplayName(resolved.provider, resolved.label, resolved.id)
        );
        return;
      }
      // Capture live position when available; never wipe an existing resume target
      // with t≈0 (common when the element was already torn down mid-failover).
      const t = video?.currentTime ?? 0;
      if (t > RESUME_CAPTURE_MIN_S) {
        resumeAtRef.current = t;
        // Keep store clock on the real playhead so chrome does not flash 0:00.
        setCurrentTime(t);
      } else if (resumeAtRef.current > RESUME_CAPTURE_MIN_S) {
        setCurrentTime(resumeAtRef.current);
      }
      // Allow a fresh seek apply on the new stream (resume target kept above).
      initialTimeAppliedRef.current = false;
      invalidateSourceAttempt();
      setError(null);
      setBuffering(true);
      // After first frame: compact chip only — never full-screen Resolving overlay.
      if (everPlayedRef.current || t > HEALTHY_PLAY_LOCK_S) {
        setIsSwitchingServer(true);
      }
      setActiveSource(resolved);
      if (sameMediaIdentity) {
        // A failed same-URL manual retry needs an explicit setup-effect key;
        // setting the same source object/id/url alone does not remount media.
        if (opts?.userPick) {
          failedSourceIdsRef.current.delete(resolved.id);
          setFailedSourceIds((prev) => prev.filter((id) => id !== resolved.id));
        }
        setSourceReloadGeneration((generation) => generation + 1);
      }
      // Only persist preference on explicit user pick — auto failover must not stick Luna forever.
      if (opts?.userPick) {
        setPreferredProvider(preferenceKey(resolved));
      }
      setServerDisplayName(
        getServerDisplayName(resolved.provider, resolved.label, resolved.id)
      );
    },
    [
      setError,
      setBuffering,
      setServerDisplayName,
      setCurrentTime,
      invalidateSourceAttempt,
    ]
  );

  /** Dock / settings server pick — locks out enrich auto-upgrade for this session. */
  const handleUserSourceChange = useCallback(
    (source: PlaybackSource) => {
      if (!isSourcePlayableHere(source)) return;
      userSelectedSourceRef.current = true;
      handleSourceChange(source, { userPick: true });
    },
    [handleSourceChange]
  );

  /** "'Zeus' unavailable — switched to 'Apollo'" — names both ends of the hop. */
  const showFailoverNotice = useCallback((failed: PlaybackSource, next: PlaybackSource) => {
    const failedName = getServerDisplayName(failed.provider, failed.label, failed.id);
    const nextName = getServerDisplayName(next.provider, next.label, next.id);
    setFailoverNotice(`'${failedName}' unavailable — switched to '${nextName}'`);
    if (failoverNoticeTimerRef.current) clearTimeout(failoverNoticeTimerRef.current);
    failoverNoticeTimerRef.current = setTimeout(() => {
      failoverNoticeTimerRef.current = null;
      setFailoverNotice(null);
    }, FAILOVER_NOTICE_MS);
  }, []);

  const showStatusNotice = useCallback((message: string, durationMs: number) => {
    setFailoverNotice(message);
    if (failoverNoticeTimerRef.current) clearTimeout(failoverNoticeTimerRef.current);
    failoverNoticeTimerRef.current = setTimeout(() => {
      failoverNoticeTimerRef.current = null;
      setFailoverNotice(null);
    }, durationMs);
  }, []);

  /** One-shot "Resuming from mm:ss" toast — see RESUME_NOTICE_MS. */
  const showResumeNotice = useCallback((seconds: number) => {
    setResumeNotice(`Resuming from ${formatClock(seconds)}`);
    if (resumeNoticeTimerRef.current) clearTimeout(resumeNoticeTimerRef.current);
    resumeNoticeTimerRef.current = setTimeout(() => {
      resumeNoticeTimerRef.current = null;
      setResumeNotice(null);
    }, RESUME_NOTICE_MS);
  }, []);

  const recordDetectedHeight = useCallback((sourceId: string, height: number) => {
    if (!sourceId || height <= 0) return;
    setDetectedHeights((prev) => {
      if (prev[sourceId] === height) return prev;
      return { ...prev, [sourceId]: height };
    });
  }, []);

  const tryNextSource = useCallback(() => {
    if (activeSource) markSourceFailed(activeSource.id);
    const available = eligiblePlaybackSources(
      orderedSources,
      failedSourceIdsRef.current
    );
    const next = pickDefaultSource(
      available,
      getPreferredProvider(),
      qualityTargetRef.current
    );
    if (next) {
      handleSourceChange(next);
      // Only surface after first healthy play — cold hunting already has its own UI.
      if (everPlayedRef.current && activeSource) showFailoverNotice(activeSource, next);
      return true;
    }
    return false;
  }, [activeSource, orderedSources, handleSourceChange, markSourceFailed, showFailoverNotice]);

  // Auto-upgrade ONLY before first healthy play (Luna → Solstice etc.).
  // Once everPlayed, freeze CDN thrash — mid-watch thrash caused res drops.
  // Change 12 (confirmed sub-1080 quality upgrade) is a separate once-per-session path.
  useEffect(() => {
    if (!activeSource || !orderedSources.length) return;
    if (userSelectedSourceRef.current || autoUpgradedRef.current) return;
    if (everPlayedRef.current) return;
    if (!orderedSources.some((s) => s.id === activeSource.id)) return;

    const video = videoRef.current;
    const pos = video?.currentTime ?? 0;
    if (
      video &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0
    ) {
      markEverPlayed();
      return;
    }
    if (pos >= AUTO_UPGRADE_MAX_POSITION_S) return;
    // Any real decode past lock threshold freezes CDN upgrades permanently.
    if (
      pos >= HEALTHY_PLAY_LOCK_S &&
      video &&
      video.readyState >= 2 &&
      !video.seeking
    ) {
      markEverPlayed();
      return;
    }

    const pick = pickDefaultSource(
      orderedSources,
      getPreferredProvider(),
      qualityTargetRef.current
    );
    if (!pick || pick.id === activeSource.id) return;

    const activeIsLuna =
      activeSource.label.toLowerCase() === "luna" ||
      activeSource.provider.toLowerCase().includes("vixsrc");
    const pickIsFaster = isFasterSource(activeSource, pick);
    const pickIsNamedFast =
      pick.provider.toLowerCase().includes("vidking") ||
      pick.label.toLowerCase().startsWith("horizon") ||
      pick.label.toLowerCase().startsWith("aether") ||
      pick.label.toLowerCase().startsWith("solstice");
    const activeWeak =
      activeIsLuna ||
      activeSource.probe?.ok === false ||
      (activeSource.probe == null && pick.probe?.ok === true);
    const pickIsBetter =
      pickIsFaster ||
      (activeIsLuna && pickIsNamedFast) ||
      (activeWeak && pickIsNamedFast) ||
      (activeWeak && pick.probe?.ok === true && pickIsFaster);

    if (!pickIsBetter) return;
    if (!activeIsLuna && !activeWeak) return;

    autoUpgradedRef.current = true;
    handleSourceChange(pick);
  }, [orderedSources, activeSource, handleSourceChange, markEverPlayed]);

  /**
   * Change 3 residual — when background poll adds PW/new sources mid-watch,
   * show a dismissible nudge only. Never auto-switch a healthy playing source.
   */
  useEffect(() => {
    if (!orderedSources.length) return;
    const newIds = findNewSourceIds(seenSourceIdsRef.current, orderedSources);
    for (const s of orderedSources) seenSourceIdsRef.current.add(s.id);
    if (!newIds.length) return;
    // Only nudge after the user is already watching — cold start is hunting UI.
    if (!everPlayedRef.current) return;
    setNewSourceNotice(true);
    if (newSourceNoticeTimerRef.current) clearTimeout(newSourceNoticeTimerRef.current);
    newSourceNoticeTimerRef.current = setTimeout(() => {
      newSourceNoticeTimerRef.current = null;
      setNewSourceNotice(false);
    }, NEW_SOURCE_NOTICE_MS);
  }, [orderedSources]);

  /**
   * Background Server-list health probing — bounded concurrency, cached by
   * URL (module-scope `bgHealthProbeCache`). Only probes non-active sources
   * that arrived with no server-side `probe` at all; never re-probes one
   * that already has server-measured data, never probes the active source
   * (its health is already proven by virtue of playing), and never feeds
   * auto-selection — only the Server list's badge/health dot.
   */
  useEffect(() => {
    if (!orderedSources.length) return;
    const candidates = orderedSources
      .filter(
        (s) =>
          s.id !== activeSource?.id &&
          !isPoisonStreamUrl(s.url) &&
          isSameOriginPlaybackUrl(s.url) &&
          s.probe == null &&
          probedHealth[s.id] == null &&
          !probeInFlightRef.current.has(s.id)
      )
      .slice(0, BG_HEALTH_PROBE_MAX_PER_PASS);
    if (!candidates.length) return;

    let cancelled = false;
    const byUrl = new Map(candidates.map((c) => [c.url, c.id] as const));
    for (const c of candidates) probeInFlightRef.current.add(c.id);

    runBoundedHealthProbes(
      candidates.map((c) => c.url),
      BG_HEALTH_PROBE_CONCURRENCY,
      (url, probe) => {
        if (cancelled) return;
        const id = byUrl.get(url);
        if (!id) return;
        setProbedHealth((prev) => (prev[id] ? prev : { ...prev, [id]: probe }));
      }
    ).finally(() => {
      for (const c of candidates) probeInFlightRef.current.delete(c.id);
    });

    return () => {
      cancelled = true;
    };
    // Deliberately excludes `probedHealth` — it only gates which candidates
    // are queued (read fresh via closure whenever this re-runs), never a
    // trigger for re-running itself, or every resolved probe would re-arm
    // this effect and cycle indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedSources, activeSource?.id]);

  tryNextSourceRef.current = tryNextSource;

  const handleRetryFull = useCallback(() => {
    // Same source id may come back from the re-fetch with a renewed URL
    // (expired token, transient scrape miss) — see pendingUrlRefreshRef.
    pendingUrlRefreshRef.current = true;
    userPausedRef.current = false;
    terminalBlockedRef.current = false;
    setError(null);
    setBuffering(true);
    if (everPlayedRef.current) setIsSwitchingServer(true);
    onRetrySourcesRef.current?.();
  }, [setError, setBuffering]);

  /**
   * Shared failover surface — hoisted to component scope (was duplicated
   * inline in three places: the stream-setup effect, the onWaiting stall
   * timer, and the native `error` listener) so task 2's discovery-closed
   * re-arm and task 7's playhead watchdog can call the exact same path.
   */
  const failActiveSource = useCallback(
    (
      reason = "terminal_error",
      attempt = sourceAttemptControllerRef.current.currentToken()
    ): boolean => {
      if (!attempt || !sourceAttemptControllerRef.current.claimTerminal(attempt)) {
        return false;
      }
      setLevelsPending(false);
      const source = activeSourceRef.current;
      // The generation check above owns race safety. Keep this source-id
      // invariant explicit so a future transition cannot reintroduce stale-id
      // failover by forgetting to invalidate its old attempt.
      if (!source || source.id !== attempt.sourceId) {
        return false;
      }
      markSourceFailed(attempt.sourceId);
      console.info(
        "[playback-failure]",
        JSON.stringify({
          sourceId: attempt.sourceId,
          generation: attempt.generation,
          reason,
          at: Date.now(),
        })
      );
      // Fatal media/network failure → next source now. Never wait for enrich.
      if (tryNextSourceRef.current()) return true;
      // Only hold for more sources if we have literally nothing left to try
      // AND enrich is still open — otherwise surface hard error immediately.
      // Read roster via ref so this callback stays stable across enrich polls.
      const roster = orderedSourcesRef.current;
      const remaining = eligiblePlaybackSources(
        roster.filter((s) => s.id !== source.id),
        failedSourceIdsRef.current
      );
      if (isDiscoveringRef.current && remaining.length === 0) {
        setBuffering(true);
        setError(null);
        return true;
      }
      if (requestAutomaticRosterRefresh()) return true;
      setBuffering(false);
      setError(ALL_SOURCES_FAILED_MSG);
      return true;
    },
    [
      markSourceFailed,
      setBuffering,
      setError,
      requestAutomaticRosterRefresh,
    ]
  );

  const noteHardTransportFailure = useCallback(
    (attempt: SourceAttemptToken, reason: string): void => {
      const signal =
        sourceAttemptControllerRef.current.noteHardTransportFailure(attempt);
      if (signal === "terminal") {
        failActiveSource(reason, attempt);
      }
    },
    [failActiveSource]
  );

  // Fail over even while enrich is running — never wait for scrape complete.
  // Wall duration is adaptive (R8): cold multi-source ~20s; resume / sole source ~28s.
  // Re-keys on activeSource?.id so pre-play CDN auto-upgrade resets the timer once.
  // Intentionally NOT dependent on orderedSources — enrich arrivals must not reset the wall.
  useEffect(() => {
    if (everPlayed || !hasStream) return;
    const remainingSources = orderedSources.filter(
      (s) => !failedSourceIdsRef.current.has(s.id) && s.id !== activeSource?.id
    ).length;
    const resumeAt =
      resumeAtRef.current > RESUME_SLOW_THRESHOLD_S
        ? resumeAtRef.current
        : (initialTime ?? 0);
    const wallMs = firstFrameWallMs({ resumeAt, remainingSources });
    const timer = window.setTimeout(() => {
      if (everPlayedRef.current) return;
      if (usePlayerStore.getState().error) return;
      failActiveSource("first_frame_timeout");
    }, wallMs);
    return () => window.clearTimeout(timer);
    // orderedSources read at arm time only — do not re-arm when enrich appends.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- R8: stable wall per active source
  }, [everPlayed, hasStream, activeSource?.id, initialTime, failActiveSource]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasStream) {
      setBuffering(false);
      return;
    }

    // crossOrigin is sticky on a reused <video>. A Worker source may require
    // anonymous CORS, while the next Real-Debrid/native source must not inherit
    // it or the browser rejects an otherwise playable file.
    video.removeAttribute("crossorigin");
    resetStream();
    setBuffering(true);
    setLevelsPending(true);
    setError(null);
    setAutoplayHint(null);
    networkRecoveriesRef.current = 0;
    lastStallRecoverAtRef.current = 0;
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }

    // Seed resume target from continue-watching progress when not mid-source-switch.
    // Progress often arrives after the first stream attach; a late effect seeks then.
    if (
      !initialTimeAppliedRef.current &&
      initialTime != null &&
      initialTime > RESUME_SLOW_THRESHOLD_S &&
      resumeAtRef.current < RESUME_CAPTURE_MIN_S
    ) {
      resumeAtRef.current = initialTime;
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (dashRef.current) {
      dashRef.current.reset();
      dashRef.current.destroy();
      dashRef.current = null;
    }

    // LordFlix: no "Tap play to start" copy — center play button is enough
    const onAutoplayBlocked = () => setAutoplayHint(null);
    /** Unmuted autoplay was rejected and we retried muted successfully — tell
     * the user sound is off instead of leaving them guessing (task 10b). */
    const onMutedAutoplayFallback = () => setAutoplayHint(MUTED_AUTOPLAY_HINT);

    let onMp4Loaded: (() => void) | null = null;
    let nativeTrackCleanup: (() => void) | null = null;

    /** Clear resume target only after seek is accepted — never on failed apply. */
    const applyResumeSeek = (v: HTMLVideoElement): boolean => {
      const target = resumeAtRef.current;
      if (target <= RESUME_CAPTURE_MIN_S) return false;
      try {
        v.currentTime = target;
        resumeAtRef.current = 0;
        initialTimeAppliedRef.current = true;
        // Only the "real" continue-watching resume (not a sub-5s failover
        // reposition) surfaces the toast — see RESUME_SLOW_THRESHOLD_S.
        if (target > RESUME_SLOW_THRESHOLD_S && !everPlayedRef.current) {
          showResumeNotice(target);
        }
        return true;
      } catch {
        /* ignore NotSupportedError while media not ready — keep resumeAtRef */
        return false;
      }
    };

    // Home `/api/hls` (same-origin cookies) or Cloudflare Worker (signed token, no cookies).
    const isHomeHlsProxy = effectiveSrc.startsWith("/api/hls/");
    const isTranscoded = effectiveSrc.startsWith("/api/transcode");
    const isWorkerProxy =
      effectiveSrc.includes("workers.dev") ||
      (effectiveSrc.startsWith("https://") && effectiveSrc.includes("/?t=")) ||
      Boolean(
        process.env.NEXT_PUBLIC_WORKER_PROXY_HOST &&
          effectiveSrc.includes(process.env.NEXT_PUBLIC_WORKER_PROXY_HOST)
      );
    const isProxied = isHomeHlsProxy || isWorkerProxy || isTranscoded;
    // Trust server-assigned streamType only — do NOT force hls.js for every /api/hls URL
    // (progressive mp4 proxied through /api/hls must stay progressive).
    // Transcoded sources are always HLS (h264_vaapi → HLS ladder).
    const useDash = effectiveStreamType === "dash" && !isTranscoded;
    const useHls =
      isTranscoded ||
      effectiveStreamType === "hls" ||
      (effectiveStreamType !== "mp4" && effectiveStreamType !== "dash" && effectiveSrc.includes(".m3u8"));

    const sourceAttempt = sourceAttemptControllerRef.current.begin(
      activeSourceRef.current?.id ?? effectiveSrc
    );
    // Bind the HTMLMediaElement error to this exact source generation. A
    // component-wide listener that looked up "currentToken" at callback time
    // could miss a progressive MP4 failure during a source/effect transition,
    // leaving the video paused in MEDIA_ERR_NETWORK forever. Engine callbacks
    // already carry their generation; the native media path must do the same.
    const onBoundMediaElementError = () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      failActiveSource("media_element_error", sourceAttempt);
    };
    video.addEventListener("error", onBoundMediaElementError);
    let dashCancelled = false;
    let zeroProgressTimer: ReturnType<typeof setTimeout> | null = null;
    let onTimeProgress: (() => void) | null = null;

    const clearZeroProgressTimer = () => {
      if (zeroProgressTimer != null) {
        clearTimeout(zeroProgressTimer);
        zeroProgressTimer = null;
      }
    };

    const armZeroProgressWatchdog = (delayMs: number) => {
      clearZeroProgressTimer();
      zeroProgressTimer = setTimeout(() => {
        zeroProgressTimer = null;
        const v = videoRef.current;
        const t = v?.currentTime ?? 0;
        const ready = v?.readyState ?? 0;
        if (t < 0.4 && ready < 3 && !video.ended) {
          failActiveSource("zero_progress", sourceAttempt);
        }
      }, delayMs) as unknown as ReturnType<typeof setTimeout>;
    };

    /**
     * Extended window while mid-title resume is pending; normal after seek
     * lands. A transcoded source additionally floors this at
     * `TRANSCODE_ZERO_PROGRESS_FAIL_MS` (task 5) — the transcoder can
     * legitimately take most of its own startup budget before the manifest
     * even arrives, so the default window would fail it over before it had
     * a real chance. Both concerns can compound (transcoded + resuming
     * mid-title), so this takes whichever floor is larger.
     */
    const zeroProgressDelayForResume = (): number => {
      const resumePending =
        resumeAtRef.current > RESUME_SLOW_THRESHOLD_S ||
        (!initialTimeAppliedRef.current &&
          initialTime != null &&
          initialTime > RESUME_SLOW_THRESHOLD_S);
      const base = resumePending ? HLS_ZERO_PROGRESS_FAIL_RESUME_MS : HLS_ZERO_PROGRESS_FAIL_MS;
      return isTranscoded ? Math.max(base, TRANSCODE_ZERO_PROGRESS_FAIL_MS) : base;
    };

    const applyResumeSeekAndRearm = (v: HTMLVideoElement): void => {
      const hadResume = resumeAtRef.current > RESUME_SLOW_THRESHOLD_S;
      const applied = applyResumeSeek(v);
      // After resume seek lands, start a fresh normal 14s zero-progress window.
      if (applied && hadResume) {
        armZeroProgressWatchdog(HLS_ZERO_PROGRESS_FAIL_MS);
      }
    };

    /**
     * Bandwidth/buffer stall while holding the 1080 floor: keep buffering at
     * 1080p, indefinitely. This NEVER fails the source over — only hard
     * errors (HTTP 4xx/5xx, fatal fragLoadError/manifestLoadError, decode
     * errors — handled separately below) increment the failover strike
     * count. This is the owner's explicit trade-off: a slow line buffers at
     * 1080p forever rather than downshifting or falsely marking every
     * source "failed" (the ORIGINAL P0 this debounce/recovery path exists
     * to avoid re-creating).
     */
    const recoverHlsStall = (hls: Hls) => {
      const now = Date.now();
      if (now - lastStallRecoverAtRef.current < HLS_STALL_RECOVER_DEBOUNCE_MS) return;
      lastStallRecoverAtRef.current = now;
      recoverHlsAdaptive(hls, video, qualityTargetRef.current);
    };

    if (useDash) {
      // Dynamically imported (not a static top-level import) — dashjs touches `window`
      // at module-load time, which crashes Next's SSR pass for this "use client"
      // component if imported statically. Loading it only here, client-side, inside
      // the effect, keeps SSR working while behaving identically once mounted.
      import("dashjs")
        .then((mod) => {
          if (dashCancelled) return;
          const dashjs = mod.default;
          if (!dashjs.supportsMediaSource()) {
            setLevelsPending(false);
            failActiveSource("dash_not_supported", sourceAttempt);
            return;
          }
          const player = dashjs.MediaPlayer().create();
          dashRef.current = player;
          player.updateSettings({
            streaming: {
              xhrSetup: (xhr: XMLHttpRequest) => {
                // Cookies only for same-origin home proxy; Worker uses signed tokens.
                if (isHomeHlsProxy) xhr.withCredentials = true;
                // dash.js may keep retrying 4xx/5xx responses without emitting
                // its terminal ERROR event. Bind transport failures to this
                // exact source generation so two hard failures deterministically
                // advance while abort callbacks from teardown are ignored.
                let failureReported = false;
                const reportFailure = (reason: string) => {
                  if (failureReported) return;
                  failureReported = true;
                  noteHardTransportFailure(sourceAttempt, reason);
                };
                xhr.addEventListener(
                  "error",
                  () => reportFailure("dash_transport_error"),
                  { once: true }
                );
                xhr.addEventListener(
                  "timeout",
                  () => reportFailure("dash_transport_timeout"),
                  { once: true }
                );
                xhr.addEventListener(
                  "loadend",
                  () => {
                    const status = xhr.status;
                    // status 0 on loadend alone is frequently an intentional
                    // seek/teardown abort. Real network failures are reported
                    // by the error/timeout listeners above.
                    if (status >= 400) {
                      reportFailure(`dash_http_${status}`);
                    }
                  },
                  { once: true }
                );
              },
            },
          } as Parameters<typeof player.updateSettings>[0]);
          player.initialize(video, effectiveSrc, false);

          /**
           * Absolute ABR floor guard — dash.js parity with the hls.js
           * LEVEL_SWITCHING/LEVEL_SWITCHED guards above. Registered once, for
           * every quality-change request (auto or manual), not just the
           * initial pick: if dash.js's own ABR ever requests a sub-1080
           * quality while a >=1080 rung exists on this ladder, immediately
           * override back to the floor via setQualityFor — that itself
           * dispatches a fresh QUALITY_CHANGE_REQUESTED for the floor index,
           * whose height already satisfies the guard, so this terminates in
           * one hop (no loop).
           */
          player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_REQUESTED, (data) => {
            if (data.mediaType !== "video") return;
            if (
              qualityTargetRef.current !== "auto" ||
              getQualityFloorPolicySafe() !== "absolute"
            ) {
              return;
            }
            const list = mapDashLevels(player);
            const floorIdx = findMinLevelIndexForHeight(list, HLS_MIN_HEIGHT);
            if (floorIdx < 0) return; // ladder has no >=1080 rung — nothing to floor to.
            const requested = list.find((l) => l.index === data.newQuality);
            const h = requested ? effectiveLevelHeight(requested) : 0;
            if (h > 0 && h < HLS_MIN_HEIGHT * 0.95 && data.newQuality !== floorIdx) {
              player.setQualityFor("video", floorIdx);
            }
          });
          // Honest quality UI: mirror hls.js's setPlayingHeight-on-LEVEL_SWITCHED
          // for dash — every rendered quality change (climb or the floor-guard
          // override above) updates the "actual" readout the dock shows.
          player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (data) => {
            if (data.mediaType !== "video") return;
            const list = mapDashLevels(player);
            const lvl = list.find((l) => l.index === data.newQuality);
            setPlayingHeight(lvl ? effectiveLevelHeight(lvl) : 0);
          });

          player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            setLevelsPending(false);
            setBuffering(false);
            const levelList = mapDashLevels(player);
            setLevels(levelList);
            const prefHeight = qualityTargetRef.current;
            if (prefHeight === "auto") {
              // Parity with the hls.js floor: give dash.js's own ABR a 1080
              // preference so Auto doesn't settle at the bottom of the ladder
              // (240p). minBitrate/initialBitrate are enforced inside dash.js's
              // own checkPlaybackQuality (a real floor on the ABR decision,
              // not merely an initial guess) — the QUALITY_CHANGE_REQUESTED
              // guard above is the hard backstop regardless.
              const floorKbps = findDashFloorBitrateKbps(levelList, HLS_MIN_HEIGHT);
              player.updateSettings({
                streaming: {
                  abr: {
                    autoSwitchBitrate: { video: true },
                    ...(floorKbps > 0
                      ? {
                          initialBitrate: { video: floorKbps },
                        }
                      : {}),
                  },
                },
              } as Parameters<typeof player.updateSettings>[0]);
              setQuality(-1);
            } else {
              // Prefer lowest >= preferred height (same as hls path) — never
              // land on a sub-target rung when a matching/higher one exists.
              const idx = findBestLevelForTarget(levelList, prefHeight);
              if (idx >= 0) {
                player.updateSettings({
                  streaming: { abr: { autoSwitchBitrate: { video: false } } },
                } as Parameters<typeof player.updateSettings>[0]);
                player.setQualityFor("video", idx);
                setQuality(idx);
              }
            }
            // Seed the honest "actual" readout from whatever dash.js resolved
            // the initial quality to, before the first QUALITY_CHANGE_RENDERED.
            const activeQ = player.getQualityFor("video");
            const activeLevel = levelList.find((l) => l.index === activeQ);
            setPlayingHeight(activeLevel ? effectiveLevelHeight(activeLevel) : 0);
            const savedSpeed = getSavedPlaybackSpeed();
            if (savedSpeed !== 1) video.playbackRate = savedSpeed;
            applyResumeSeekAndRearm(video);
            if (!userPausedRef.current) {
              attemptAutoplay(video, onAutoplayBlocked, onMutedAutoplayFallback);
            }
          });
          // dash.js's ERROR event only fires for genuine hard failures (manifest/
          // fragment/segment download or parse failures, MSE append errors, DRM
          // errors) — NOT for buffer stalls (those are BUFFER_EMPTY/PLAYBACK_WAITING,
          // a separate event this listener never sees), so this is already
          // correctly scoped to "hard errors only" per task 2's failover rule.
          player.on(dashjs.MediaPlayer.events.ERROR, () => {
            failActiveSource("dash_error", sourceAttempt);
          });
        })
        .catch(() => {
          if (dashCancelled) return;
          failActiveSource("dash_initialize_error", sourceAttempt);
        });
    } else if (useHls) {
      if (Hls.isSupported()) {
        const startPos = resumeAtRef.current > 1 ? resumeAtRef.current : -1;
        const hls = new Hls({
          // Manifest parsing must not race the profile quality selection. With
          // auto-start enabled, hls.js's internal MANIFEST_PARSED listener can
          // request a low first fragment before our listener applies a fixed
          // 720/1080/4K preference. Start explicitly after selection instead.
          autoStartLoad: false,
          // Workers break on some Chromium forks (Opera Air / GX) and stall on multi-audio masters.
          enableWorker: false,
          // VOD only (no live edge to chase) — verified false; low-latency mode
          // shrinks buffers/targets latency over throughput, the opposite of
          // what a double-hop residential proxy needs.
          lowLatencyMode: false,
          // Start level is set on MANIFEST_PARSED; skip lowest-level bandwidth probe.
          startLevel: -1,
          // Continue-watching: start fragments near saved position (avoids 0:00 flash).
          startPosition: startPos,
          testBandwidth: false,
          // Verified on: prefetches the first fragment while the manifest/level
          // request is still in flight — shaves the cold-start gap before any
          // buffering can begin, no downside for VOD.
          startFragPrefetch: true,
          abrEwmaDefaultEstimate: HLS_ABR_DEFAULT_ESTIMATE_BPS,
          abrEwmaFastVoD: 3,
          abrEwmaSlowVoD: 9,
          abrMaxWithRealBitrate: true,
          // Never cap by CSS box size — that was the 1080 label / 720 reality bug.
          capLevelToPlayerSize: false,
          maxBufferLength: HLS_MAX_BUFFER_LENGTH_S,
          maxMaxBufferLength: HLS_MAX_MAX_BUFFER_LENGTH_S,
          maxBufferSize: HLS_MAX_BUFFER_SIZE_BYTES,
          maxBufferHole: 0.8,
          backBufferLength: HLS_BACK_BUFFER_LENGTH_S,
          nudgeMaxRetry: 8,
          highBufferWatchdogPeriod: 1,
          // Faster recovery from double-hop underruns across browsers.
          maxStarvationDelay: 3,
          maxLoadingDelay: 3,
          // Transcode startup (task 5): a fresh transcode can legitimately take
          // most of its own server-side budget before the manifest arrives —
          // see TRANSCODE_MANIFEST_LOADING_TIMEOUT_MS above. Retries are capped
          // to 1 for a transcoded source (vs the default 3) since the shared
          // zero-progress watchdog (armed with TRANSCODE_ZERO_PROGRESS_FAIL_MS
          // right after loadSource, below) is the real outer bound regardless —
          // no need to multiply an already-generous per-attempt timeout.
          manifestLoadingTimeOut: isTranscoded
            ? TRANSCODE_MANIFEST_LOADING_TIMEOUT_MS
            : HLS_MANIFEST_LOADING_TIMEOUT_MS,
          manifestLoadingMaxRetry: isTranscoded ? 1 : 3,
          levelLoadingTimeOut: HLS_LEVEL_LOADING_TIMEOUT_MS,
          levelLoadingMaxRetry: 4,
          fragLoadingTimeOut: HLS_FRAG_LOADING_TIMEOUT_MS,
          fragLoadingMaxRetry: 6,
          // Prefer EN but do not block first frame if only other langs exist (Luna multi-audio).
          audioPreference: { lang: getPreferredAudioLanguage() },
          xhrSetup: (xhr) => {
            // Same-origin /api/hls needs session cookies (NextAuth).
            if (isHomeHlsProxy) xhr.withCredentials = true;
          },
        });
        hlsRef.current = hls;

        // Stuck at 0:00 watchdog — MANIFEST_PARSED alone is not success (Aether PNG segments).
        // Mid-title resume uses a longer window so slow seeks are not failed over early.
        armZeroProgressWatchdog(zeroProgressDelayForResume());
        onTimeProgress = () => {
          // Progress past cold start (or past resume target) means the source is alive.
          const t = video.currentTime ?? 0;
          const resumeTarget = resumeAtRef.current;
          const pastResume =
            resumeTarget > RESUME_SLOW_THRESHOLD_S
              ? t >= resumeTarget - 1
              : t >= 0.5;
          if (pastResume) clearZeroProgressTimer();
        };
        video.addEventListener("timeupdate", onTimeProgress);

        const refreshHlsLevels = () => {
          const levelList = levelsFromHls(hls);
          setLevels(levelList);
          const pref = qualityTargetRef.current;
          const storeQ = usePlayerStore.getState().quality;
          // Fixed 1080: if stall dipped us below target, re-promote when buffer is healthy.
          if (pref !== "auto" && storeQ !== -1 && videoRef.current) {
            const curIdx = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
            const cur = levelList.find((l) => l.index === curIdx);
            const curH = cur ? effectiveLevelHeight(cur) : 0;
            const want = pref;
            if (curH > 0 && curH < want * 0.9) {
              const promoted = maybePromoteHlsQuality(
                hls,
                levelList,
                videoRef.current,
                qualityTargetRef.current
              );
              if (promoted != null && promoted >= 0) setQuality(promoted);
            }
            return;
          }
          if (storeQ === -1) {
            applyHlsAutoLevelCap(hls, levelList);
          }
        };

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLevelsPending(false);
          setBuffering(false);
          networkRecoveriesRef.current = 0;
          const levelList = levelsFromHls(hls);
          setLevels(levelList);
          // English (or stored) audio when multi-lang tracks exist.
          syncHlsTracks(hls);
          // Luna-style multi-audio masters: pin a concrete track immediately so
          // first-frame is not blocked waiting for DEFAULT=Italian selection races.
          try {
            if (hls.audioTracks && hls.audioTracks.length > 0) {
              const want = getPreferredAudioLanguage().toLowerCase().slice(0, 2);
              const eng = hls.audioTracks.findIndex(
                (t) => (t.lang || "").toLowerCase().startsWith(want)
              );
              hls.audioTrack = eng >= 0 ? eng : 0;
            }
            hls.subtitleDisplay = false;
            hls.subtitleTrack = -1;
          } catch {
            /* ignore track pin failures */
          }
          const qualityIdx = applyPreferredHlsQuality(
            hls,
            levelList,
            qualityTargetRef.current
          );
          setQuality(qualityIdx);
          // Seed playing height from forced/start level so UI is honest before first switch event.
          // Use effectiveLevelHeight so bitrate-only masters aren't reported as 0p.
          const seedIdx =
            qualityIdx >= 0
              ? qualityIdx
              : hls.loadLevel >= 0
                ? hls.loadLevel
                : hls.startLevel;
          if (seedIdx >= 0) {
            const seedLevel = levelList.find((l) => l.index === seedIdx);
            if (seedLevel) setPlayingHeight(effectiveLevelHeight(seedLevel));
          }
          const savedSpeed = getSavedPlaybackSpeed();
          if (savedSpeed !== 1) video.playbackRate = savedSpeed;
          applyResumeSeekAndRearm(video);
          try {
            hls.startLoad(startPos);
          } catch {
            failActiveSource("hls_start_error", sourceAttempt);
            return;
          }
          if (!userPausedRef.current) {
            attemptAutoplay(video, onAutoplayBlocked, onMutedAutoplayFallback);
          }
        });

        /** Reflect a promotion without mutating engine state a second time. */
        const applyPromotionResult = (promoted: number | null) => {
          if (promoted == null || promoted < 0) return;
          const wasAuto = usePlayerStore.getState().quality === -1;
          setQuality(wasAuto ? -1 : promoted);
        };

        hls.on(Hls.Events.LEVELS_UPDATED, refreshHlsLevels);
        hls.on(Hls.Events.LEVEL_LOADED, refreshHlsLevels);
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          const levelList = levelsFromHls(hls);
          if (videoRef.current && levelList.length) {
            applyPromotionResult(
              maybePromoteHlsQuality(
                hls,
                levelList,
                videoRef.current,
                qualityTargetRef.current
              )
            );
          }
        });

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          const audio = mapAudioTracks(hls);
          setAudioTracks(audio);
          if (audio.length === 0) return;
          // Re-apply preference when the track set changes (source / late media groups).
          const audioId = pickPreferredAudioId(hls);
          if (hls.audioTrack !== audioId) {
            hls.audioTrack = audioId;
          }
          setActiveAudioId(typeof hls.audioTrack === "number" ? hls.audioTrack : audioId);
        });

        // Some masters only expose AUDIO groups after the first level loads.
        const refreshAudioLater = () => {
          const audio = mapAudioTracks(hls);
          if (audio.length === 0) return;
          setAudioTracks(audio);
          const audioId = pickPreferredAudioId(hls);
          if (hls.audioTrack !== audioId) hls.audioTrack = audioId;
          setActiveAudioId(typeof hls.audioTrack === "number" ? hls.audioTrack : audioId);
        };
        hls.on(Hls.Events.LEVEL_LOADED, refreshAudioLater);
        hls.on(Hls.Events.LEVEL_SWITCHED, refreshAudioLater);

        /**
         * Absolute ABR floor guard, part 1 (pre-emptive): fires BEFORE the
         * switch takes effect. If ABR (or any other path) is about to switch
         * to a sub-1080 level while a >=1080 rung exists on this ladder,
         * seed the next Auto load at the floor without permanently setting
         * hls.js manualLevel. Auto may still climb above 1080 afterward.
         */
        hls.on(Hls.Events.LEVEL_SWITCHING, (_e, data) => {
          if (
            qualityTargetRef.current !== "auto" ||
            getQualityFloorPolicySafe() !== "absolute"
          ) {
            return;
          }
          const levelList = levelsFromHls(hls);
          const requested = levelList.find((l) => l.index === data.level);
          const h = requested ? effectiveLevelHeight(requested) : 0;
          if (h <= 0) return;
          const ladderMax = maxLevelHeight(levelList);
          if (h < HLS_MIN_HEIGHT * 0.95 && ladderMax >= HLS_MIN_HEIGHT) {
            const floorIdx = findMinLevelIndexForHeight(levelList, HLS_MIN_HEIGHT);
            if (floorIdx >= 0 && floorIdx !== data.level) {
              seedNextAutoLevel(hls, floorIdx);
            }
          }
        });

        // Absolute ABR floor guard, part 2 (reactive backstop): truthful
        // quality UI + a hard floor — never stay below 1080 once a >=1080
        // rung exists, regardless of measured bandwidth (no starvation
        // exception anymore — the owner's policy is buffer-not-downshift).
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          const list = levelsFromHls(hls);
          const level = list.find((l) => l.index === data.level);
          const h = level ? effectiveLevelHeight(level) : 0;
          const decoded = decodedQualityHeight(
            video.videoWidth || 0,
            video.videoHeight || 0
          );
          // Decoder dimensions are authoritative. LEVEL_SWITCHED can arrive
          // before the new frame is rendered, so keep the previous decoded
          // tier until the video `resize` event confirms the new raster.
          setPlayingHeight(decoded > 0 ? decoded : h);
          if (h > 0 && h < HLS_MIN_HEIGHT * 0.95 && videoRef.current) {
            applyPromotionResult(
              maybePromoteHlsQuality(
                hls,
                list,
                videoRef.current,
                qualityTargetRef.current
              )
            );
          }
        });

        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
          const subs = mapSubtitleTracks(hls);
          setSubtitleTracks(subs);
          // Late-arriving EXT-X-MEDIA subtitles: re-apply the user's persisted
          // intent (not store state, which resetStream() clears per source).
          if (!subtitleIntentRef.current.on || subs.length === 0) {
            hls.subtitleTrack = -1;
            hls.subtitleDisplay = false;
            return;
          }
          const wantLang = subtitleIntentRef.current.lang;
          const subId =
            (wantLang
              ? subs.find((t) => (t.lang ?? "").toLowerCase() === wantLang.toLowerCase())?.id
              : undefined) ??
            subs.find((t) => isEnglishTrack(t.lang, t.name))?.id ??
            subs[0].id;
          hls.subtitleTrack = subId;
          hls.subtitleDisplay = true;
          setActiveSubtitleId(subId);
          setSubtitlesOn(true);
        });

        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => {
          setActiveAudioId(data.id);
        });

        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_e, data) => {
          setActiveSubtitleId(data.id >= 0 ? data.id : null);
          setSubtitlesOn(data.id >= 0);
        });

        hls.on(Hls.Events.ERROR, (_e, data) => {
          const httpCode =
            typeof data.response?.code === "number" ? data.response.code : 0;
          const isHardHttp = HLS_HARD_HTTP_CODES.has(httpCode);

          // Signed media URLs expire during long watches. Refresh owns this
          // exact source generation before generic hard-HTTP retry/failover:
          // repeated 410 callbacks are single-flighted, the dying engine is
          // stopped, and only rejection/timeout may release terminal handling.
          if (isSessionExpiredError(data) && onRetrySourcesRef.current) {
            const refreshSignal =
              sourceAttemptControllerRef.current.requestRefresh(sourceAttempt);
            if (refreshSignal === "ignored" || refreshSignal === "pending") return;
            if (refreshSignal === "exhausted") {
              failActiveSource(
                "hls_session_refresh_exhausted",
                sourceAttempt
              );
              return;
            }

            try {
              hls.stopLoad();
            } catch {
              /* the generation token still owns refresh arbitration */
            }
            pendingUrlRefreshRef.current = true;
            setBuffering(true);
            if (everPlayedRef.current) setIsSwitchingServer(true);
            clearSessionRefresh(sourceAttempt);
            const refreshTimer = setTimeout(() => {
              if (!clearSessionRefresh(sourceAttempt)) return;
              if (
                sourceAttemptControllerRef.current.finishRefresh(sourceAttempt)
              ) {
                failActiveSource("hls_session_refresh_timeout", sourceAttempt);
              }
            }, HLS_SESSION_REFRESH_TIMEOUT_MS);
            sessionRefreshRef.current = {
              attempt: sourceAttempt,
              timer: refreshTimer,
            };
            void Promise.resolve()
              .then(() => onRetrySourcesRef.current?.())
              .catch(() => {
                if (
                  clearSessionRefresh(sourceAttempt) &&
                  sourceAttemptControllerRef.current.finishRefresh(sourceAttempt)
                ) {
                  failActiveSource("hls_session_refresh_failed", sourceAttempt);
                }
              });
            return;
          }

          // Non-fatal hard HTTP (403/502 segment denials) — storm → failover once.
          if (!data.fatal && isHardHttp) {
            noteHardTransportFailure(sourceAttempt, `hls_http_${httpCode}`);
            if (!sourceAttemptControllerRef.current.isCurrent(sourceAttempt)) return;
          }

          if (!data.fatal) {
            // Bandwidth/buffer signals (not hard HTTP denials, handled
            // above): buffer stalls and fragment-load timeouts are NOT hard
            // errors — they never increment a failover strike. Adaptive Auto
            // may step down using measured buffer; fixed/absolute quality is
            // retained. Neither path falsely marks the source dead.
            if (
              data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
            ) {
              recoverHlsStall(hls);
            }
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try {
              hls.recoverMediaError();
              return;
            } catch {
              /* fall through */
            }
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (isHardHttp) {
              noteHardTransportFailure(sourceAttempt, `hls_http_${httpCode}`);
              if (!sourceAttemptControllerRef.current.isCurrent(sourceAttempt)) return;
            }
            if (networkRecoveriesRef.current < HLS_MAX_NETWORK_RECOVERIES) {
              networkRecoveriesRef.current += 1;
              try {
                hls.startLoad();
                return;
              } catch {
                /* fall through */
              }
            }
          }
          failActiveSource("hls_fatal_error", sourceAttempt);
        });

        // A cached local manifest can parse in the same task as loadSource().
        // Register every lifecycle/quality/error listener first; otherwise a
        // fast cross-server quality switch can miss MANIFEST_PARSED entirely,
        // skip the requested fixed rung, and let hls.js start on an arbitrary
        // ABR level (the observed 480p -> 720p race).
        hls.loadSource(effectiveSrc);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS (Safari/AVFoundation) — documented limitation (task 3):
        // there is no JS-level API to select or floor a specific rendition
        // here. `video.videoTracks`/`audioTracks` on Safari's native HLS
        // represent alternate angles/audio, not ABR renditions, and
        // AVFoundation's own ABR engine (ladder selection, ramp-up/down) runs
        // entirely inside the OS with no hook to cap or floor it from script.
        // In practice Safari's ABR already targets the highest sustainable
        // rendition, so this is a floor we can request via the manifest
        // (EXT-X-STREAM-INF ordering) but cannot enforce or verify from here.
        video.src = effectiveSrc;
        setLevelsPending(false);
        setBuffering(false);
        // Seed from source metadata when known; refine with videoHeight on meta
        // (cannot force ABR floor on native HLS — documented limitation).
        {
          const metaH = activeSourceRef.current
            ? sourceMaxHeight(activeSourceRef.current)
            : 0;
          if (metaH > 0) {
            setLevels([{ index: 0, height: metaH }]);
            setPlayingHeight(metaH);
          }
          setQuality(-1);
        }
        const onNativeMeta = () => {
          const vh = video.videoHeight || 0;
          if (vh > 0) {
            const decodedTier = decodedQualityHeight(
              video.videoWidth || 0,
              vh
            );
            setPlayingHeight(decodedTier);
            const sid = activeSourceRef.current?.id;
            if (sid) recordDetectedHeight(sid, decodedTier);
          }
          syncNativeTracks(video);
          applyResumeSeekAndRearm(video);
        };
        const onNativeTracks = () => syncNativeTracks(video);
        video.addEventListener("loadedmetadata", onNativeMeta);
        video.textTracks.addEventListener("addtrack", onNativeTracks);
        // Transcode startup (task 5): AVFoundation's native HLS path has no
        // engine-level manifest-timeout hook to lean on (unlike hls.js above),
        // so a transcoded source (e.g. an MKV release even Safari can't
        // demux directly) that never actually starts producing frames would
        // otherwise hang here forever. Reuse the same bounded zero-progress
        // watchdog — engine-agnostic, it only reads `video.currentTime`/
        // `readyState` — gated to the transcode case so plain native-HLS
        // embeds keep their existing (unbounded, buffer-not-fail) behavior.
        let onNativeTranscodeProgress: (() => void) | null = null;
        if (isTranscoded) {
          armZeroProgressWatchdog(TRANSCODE_ZERO_PROGRESS_FAIL_MS);
          onNativeTranscodeProgress = () => {
            if ((video.currentTime ?? 0) >= 0.5) clearZeroProgressTimer();
          };
          video.addEventListener("timeupdate", onNativeTranscodeProgress);
        }
        nativeTrackCleanup = () => {
          video.removeEventListener("loadedmetadata", onNativeMeta);
          video.textTracks.removeEventListener("addtrack", onNativeTracks);
          if (onNativeTranscodeProgress) {
            video.removeEventListener("timeupdate", onNativeTranscodeProgress);
          }
        };
        if (!userPausedRef.current) {
          attemptAutoplay(video, onAutoplayBlocked, onMutedAutoplayFallback);
        }
      } else {
        setLevelsPending(false);
        setBuffering(false);
        setError("Your browser can't play HLS streams.");
      }
    } else {
      if (isWorkerProxy) {
        video.crossOrigin = "anonymous";
      }
      video.src = effectiveSrc;
      setLevelsPending(false);
      setBuffering(false);
      // Progressive / single-URL: no adaptive ladder — seed honest single-rung
      // metadata from the source when known, then refine with video.videoHeight.
      {
        const metaH = activeSourceRef.current
          ? sourceMaxHeight(activeSourceRef.current)
          : 0;
        if (metaH > 0) {
          setLevels([{ index: 0, height: metaH }]);
          setPlayingHeight(metaH);
        } else {
          setLevels([]);
          setPlayingHeight(0);
        }
        setQuality(-1);
      }
      onMp4Loaded = () => {
        const vh = video.videoHeight || 0;
        if (vh > 0) {
          const decodedTier = decodedQualityHeight(
            video.videoWidth || 0,
            vh
          );
          setPlayingHeight(decodedTier);
          // Prefer decoded height over source-label metadata for honesty.
          // Single-rung only — never invent a multi-rung menu for progressive MP4.
          setLevels([{ index: 0, height: decodedTier }]);
          const sid = activeSourceRef.current?.id;
          if (sid) recordDetectedHeight(sid, decodedTier);
        }
        applyResumeSeekAndRearm(video);
        video.removeEventListener("loadedmetadata", onMp4Loaded!);
      };
      video.addEventListener("loadedmetadata", onMp4Loaded);
      if (!userPausedRef.current) {
        attemptAutoplay(video, onAutoplayBlocked, onMutedAutoplayFallback);
      }
    }

    return () => {
      dashCancelled = true;
      // Engine teardown clears/reloads the shared media element and emits a
      // native pause. Tag it before pause() so an active PiP session does not
      // persist "user paused" and suppress the replacement source's autoplay.
      if (!video.paused) {
        pauseIntentControllerRef.current.expectInternalPause();
        video.pause();
      }
      video.removeEventListener("error", onBoundMediaElementError);
      // reset()/destroy() can synchronously abort XHR and emit loadend. Make
      // that callback stale before teardown starts.
      sourceAttemptControllerRef.current.invalidate(sourceAttempt);
      clearSessionRefresh(sourceAttempt);
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      clearZeroProgressTimer();
      if (onTimeProgress) video.removeEventListener("timeupdate", onTimeProgress);
      if (onMp4Loaded) video.removeEventListener("loadedmetadata", onMp4Loaded);
      nativeTrackCleanup?.();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (dashRef.current) {
        dashRef.current.reset();
        dashRef.current.destroy();
        dashRef.current = null;
      }
      video.src = "";
      video.load();
    };
    // initialTime is intentionally not a dep — late progress is applied by the seek effect
    // below without tearing down hls.js mid-play.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stream identity only
  }, [
    effectiveSrc,
    activeSource?.id,
    sourceReloadGeneration,
    hasStream,
    effectiveStreamType,
    resetStream,
    setBuffering,
    setLevels,
    setError,
    setQuality,
    setPlayingHeight,
    markSourceFailed,
    syncHlsTracks,
    syncNativeTracks,
    failActiveSource,
    noteHardTransportFailure,
    recordDetectedHeight,
  ]);

  /**
   * Late continue-watching progress: stream often attaches before /api/progress returns.
   * Seek once when initialTime arrives. Only abandon if the user already scrubbed past
   * the resume target (currentTime > target + slack) — not merely because t≥3 during
   * slow buffering of the cold start.
   */
  useEffect(() => {
    if (initialTime == null || initialTime <= RESUME_SLOW_THRESHOLD_S || initialTimeAppliedRef.current) {
      return;
    }
    if (resumeAtRef.current < RESUME_CAPTURE_MIN_S) resumeAtRef.current = initialTime;

    const video = videoRef.current;
    if (!video || !hasStream) return;

    const seekIfEarly = (): void => {
      if (initialTimeAppliedRef.current) return;
      const target =
        resumeAtRef.current > RESUME_CAPTURE_MIN_S ? resumeAtRef.current : initialTime;
      if (target == null || target <= RESUME_SLOW_THRESHOLD_S) return;

      // User scrubbed past resume target — don't yank them back.
      if (video.currentTime > target + RESUME_ABANDON_SLACK_S) {
        initialTimeAppliedRef.current = true;
        resumeAtRef.current = 0;
        return;
      }

      if (video.readyState < 1) return;
      try {
        video.currentTime = target;
        initialTimeAppliedRef.current = true;
        resumeAtRef.current = 0;
        if (!everPlayedRef.current) showResumeNotice(target);
      } catch {
        /* not ready — keep resumeAtRef for next attempt */
      }
    };

    seekIfEarly();
    if (initialTimeAppliedRef.current) return;

    video.addEventListener("loadedmetadata", seekIfEarly);
    video.addEventListener("durationchange", seekIfEarly);
    video.addEventListener("canplay", seekIfEarly);
    return () => {
      video.removeEventListener("loadedmetadata", seekIfEarly);
      video.removeEventListener("durationchange", seekIfEarly);
      video.removeEventListener("canplay", seekIfEarly);
    };
  }, [initialTime, hasStream, effectiveSrc]);

  useEffect(() => {
    const hls = hlsRef.current;
    const video = videoRef.current;

    if (hls) {
      if (
        subtitlesOn &&
        activeSubtitleId !== null &&
        hlsHasTrackId(hls.subtitleTracks, activeSubtitleId)
      ) {
        hls.subtitleTrack = activeSubtitleId;
        hls.subtitleDisplay = true;
      } else {
        hls.subtitleTrack = -1;
        hls.subtitleDisplay = false;
      }
      return;
    }

    // Native Safari path: drive TextTrack.mode from store selection.
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if (!t || (t.kind !== "subtitles" && t.kind !== "captions")) continue;
      const on =
        subtitlesOn && activeSubtitleId !== null && i === activeSubtitleId;
      t.mode = on ? "showing" : "disabled";
    }
  }, [subtitlesOn, activeSubtitleId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => {
      if (terminalBlockedRef.current) {
        userPausedRef.current = true;
        video.pause();
        setIsPlaying(false);
        return;
      }
      userPausedRef.current = false;
      setIsPlaying(true);
      setAutoplayHint(null);
    };
    const onPause = () => {
      // Playback intent is set by the command that called pause (user, sleep,
      // or terminal). Buffer arithmetic cannot distinguish a low-buffer user
      // pause from an underrun and previously allowed delayed `canplay` to
      // resume behind the terminal/sleep overlay.
      // PiP controls are native and bypass our commands, so capture that
      // untagged user-pause surface explicitly.
      const pauseDisposition =
        pauseIntentControllerRef.current.consumePause(
          document.pictureInPictureElement === video
        );
      if (pauseDisposition === "native-user") {
        userPausedRef.current = true;
      }
      // A queued teardown pause may arrive after the replacement generation
      // already started. Do not let that stale event flip current UI state.
      if (pauseDisposition === "internal" && !video.paused) return;
      setIsPlaying(false);
    };
    const onTimeUpdate = () => {
      onProgressBuf();
      const now = Date.now();
      const t = video.currentTime;
      if (now - lastTimeUpdateRef.current >= 250) {
        lastTimeUpdateRef.current = now;
        setCurrentTime(t);
      }
      // Lock hunting overlay + auto-upgrade after first healthy playhead.
      if (
        !everPlayedRef.current &&
        t >= HEALTHY_PLAY_LOCK_S &&
        video.readyState >= 2
      ) {
        markEverPlayed();
      }
      // First progress save at 2s so Continue % is honest; then every 5s.
      // Read via ref — a new onProgress identity (parent re-render, e.g. every
      // progressive-enrich poll) must never force this whole effect to re-run
      // and re-attach all media listeners (task 8).
      const progressIntervalMs = firstProgressSavedRef.current ? 5000 : 2000;
      if (
        onProgressRef.current &&
        now - lastProgressSave.current > progressIntervalMs &&
        video.duration
      ) {
        lastProgressSave.current = now;
        firstProgressSavedRef.current = true;
        onProgressRef.current(t, video.duration);
      }
      // TV binge: warm next episode sources at 80% so next-ep TTFF is near-instant.
      const nextEpTarget = nextEpisodeTargetRef.current;
      if (
        !nextEpPreloadedRef.current &&
        mediaType === "tv" &&
        tvId != null &&
        nextEpTarget &&
        video.duration > 0 &&
        t / video.duration >= NEXT_EP_PRELOAD_RATIO
      ) {
        nextEpPreloadedRef.current = true;
        void preresolvePlayback({
          mediaType: "tv",
          tmdbId: tvId,
          season: nextEpTarget.season,
          episode: nextEpTarget.episode,
        });
      }
    };
    const onDurationChange = () => setDuration(video.duration);
    const onProgressBuf = () => {
      try {
        if (video.buffered.length > 0) {
          setBufferedEnd(video.buffered.end(video.buffered.length - 1));
        }
      } catch {
        /* ignore */
      }
    };
    const onWaiting = () => {
      setBuffering(true);
      // Prolonged buffer stall: keep nudging hls.js to resume loading at the
      // 1080 floor — never fails the source over from this alone (owner's
      // absolute "buffer at 1080p, never false-fail" policy). Only hard
      // errors (handled in the hls ERROR listener / native `error` event)
      // count toward failover.
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        const hls = hlsRef.current;
        if (!hls) return;
        // HAVE_FUTURE_DATA (3) or better means we already recovered.
        if (video.readyState >= 3) return;
        const now = Date.now();
        if (now - lastStallRecoverAtRef.current < HLS_STALL_RECOVER_DEBOUNCE_MS) return;
        lastStallRecoverAtRef.current = now;
        recoverHlsAdaptive(hls, video, qualityTargetRef.current);
      }, HLS_STALL_RECOVER_DEBOUNCE_MS);
    };
    const onPlaying = () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      networkRecoveriesRef.current = 0;
      const attempt = sourceAttemptControllerRef.current.currentToken();
      if (attempt) sourceAttemptControllerRef.current.noteProgress(attempt);
      const decodedTier = decodedQualityHeight(
        video.videoWidth || 0,
        video.videoHeight || 0
      );
      if (decodedTier > 0) {
        // Manifest levels sometimes expose a cropped raster such as 1920x816.
        // Decoded dimensions are authoritative and normalize that to its
        // commercial 1080p delivery class.
        setPlayingHeight(decodedTier);
        const sid = activeSourceRef.current?.id;
        if (sid) recordDetectedHeight(sid, decodedTier);
      }
      setBuffering(false);
      setIsSwitchingServer(false);
      if (video.readyState >= 2 && (video.currentTime > 0.25 || video.duration > 0)) {
        markEverPlayed();
      }
    };
    const onVideoResize = () => {
      const decodedTier = decodedQualityHeight(
        video.videoWidth || 0,
        video.videoHeight || 0
      );
      if (decodedTier <= 0) return;
      setPlayingHeight(decodedTier);
      const sourceId = activeSourceRef.current?.id;
      if (sourceId) recordDetectedHeight(sourceId, decodedTier);
    };
    const resumeIfNeeded = () => {
      setBuffering(false);
      if (video.readyState >= 2 && video.currentTime >= HEALTHY_PLAY_LOCK_S) {
        markEverPlayed();
      }
      // After underrun browsers often leave video.paused=true while buffer refills.
      // Auto-resume unless the user deliberately paused.
      if (
        video.paused &&
        !userPausedRef.current &&
        !terminalBlockedRef.current &&
        !video.ended &&
        everPlayedRef.current &&
        video.readyState >= 3
      ) {
        void video.play().catch(() => {
          /* autoplay policy — surface hint only */
        });
      }
    };
    const onCanPlay = () => resumeIfNeeded();
    const onCanPlayThrough = () => resumeIfNeeded();
    const onVolumeChange = () => {
      setIsMuted(video.muted);
      setVolume(video.volume);
      // Any manual volume/mute change dismisses a stale muted-autoplay hint.
      setAutoplayHint((h) => (h === MUTED_AUTOPLAY_HINT ? null : h));
    };
    const onEndedHandler = () => {
      setIsPlaying(false);
      // Read via ref — see onProgressRef note above (task 8).
      onEndedRef.current?.();
    };
    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);

    /**
     * Engine-agnostic playhead watchdog (task 7): a backstop for hangs that
     * raise no `waiting`/error event at all — the DASH/native paths had ZERO
     * stall detection before this, and even hls.js can sit at readyState>=3
     * with a frozen playhead on some flaky proxied CDNs. Polls the actual
     * `<video>` element, so it works the same regardless of which engine
     * (hls.js/dash.js/native) currently drives it.
     *
     * One full no-progress window nudges the current engine. If a second full
     * window expires without actual playhead progress, the generation-bound
     * controller fails over. Real progress resets that recovery budget.
     */
    stallWatchdogBaselineRef.current = { t: Date.now(), pos: video.currentTime };
    const watchdogTimer = setInterval(() => {
      // Only a mid-watch safety net — cold-start/resume already has its own
      // (longer) zero-progress watchdog in the stream-setup effect.
      if (!everPlayedRef.current || video.paused || video.seeking || video.ended) {
        stallWatchdogBaselineRef.current = { t: Date.now(), pos: video.currentTime };
        return;
      }
      const baseline = stallWatchdogBaselineRef.current;
      const advanced = video.currentTime - baseline.pos;
      if (advanced > STALL_WATCHDOG_MIN_ADVANCE_S) {
        const attempt = sourceAttemptControllerRef.current.currentToken();
        if (attempt) {
          sourceAttemptControllerRef.current.noteHealthyPlayback(attempt);
        }
        stallWatchdogBaselineRef.current = { t: Date.now(), pos: video.currentTime };
        return;
      }
      const hasEngineRecovery = Boolean(hlsRef.current || dashRef.current);
      const isNativeProgressive =
        activeSourceRef.current?.type === "mp4" && !hasEngineRecovery;
      const thresholdMs = isNativeProgressive
        ? NATIVE_PROGRESSIVE_STALL_THRESHOLD_MS
        : STALL_WATCHDOG_THRESHOLD_MS;
      if (Date.now() - baseline.t < thresholdMs) return;

      const attempt = sourceAttemptControllerRef.current.currentToken();
      if (!attempt) return;
      const stallSignal =
        sourceAttemptControllerRef.current.noteSilentStall(
          attempt,
          !isNativeProgressive
        );
      stallWatchdogBaselineRef.current = { t: Date.now(), pos: video.currentTime };
      if (stallSignal === "terminal") {
        failActiveSource("silent_stall", attempt);
        return;
      }
      if (stallSignal !== "recover") return;

      // First full no-progress window: one engine-specific recovery nudge.
      const hls = hlsRef.current;
      if (hls) {
        recoverHlsAdaptive(hls, video, qualityTargetRef.current);
      } else if (dashRef.current) {
        try {
          dashRef.current.play();
        } catch {
          /* ignore */
        }
      } else {
        // Native path has no ABR/session object to nudge — a tiny in-place
        // seek is the only lever available to kick a stalled fetch loop.
        try {
          video.currentTime += 0.001;
        } catch {
          /* ignore */
        }
      }
    }, STALL_WATCHDOG_POLL_MS);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("loadedmetadata", onDurationChange);
    video.addEventListener("progress", onProgressBuf);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("resize", onVideoResize);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("canplaythrough", onCanPlayThrough);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ended", onEndedHandler);
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);

    return () => {
      clearInterval(watchdogTimer);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("loadedmetadata", onDurationChange);
      video.removeEventListener("progress", onProgressBuf);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("resize", onVideoResize);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("canplaythrough", onCanPlayThrough);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ended", onEndedHandler);
      video.removeEventListener("enterpictureinpicture", onEnterPip);
      video.removeEventListener("leavepictureinpicture", onLeavePip);
    };
    // onProgress/onEnded/nextEpisodeTarget intentionally excluded — read via
    // refs above so a new prop identity never re-attaches all media listeners
    // (task 8; watch.tsx's progressive-enrich polling re-renders ~every 2-5s).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setIsPlaying,
    setCurrentTime,
    setDuration,
    setBuffering,
    setPlayingHeight,
    setIsMuted,
    setVolume,
    setIsPip,
    setError,
    markSourceFailed,
    markEverPlayed,
    recordDetectedHeight,
    failActiveSource,
    mediaType,
    tvId,
  ]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [setIsFullscreen]);

  const closeDock = useCallback(() => {
    setDockOpen(false);
    setDockSection(null);
  }, []);

  const terminalError = Boolean(
    error || (!hasStream && sourcesError && !sourcesLoading)
  );

  useEffect(() => {
    terminalBlockedRef.current = terminalError;
    if (!terminalError) return;
    userPausedRef.current = true;
    videoRef.current?.pause();
    setIsPlaying(false);
    setBuffering(false);
    setIsSwitchingServer(false);
    setDockOpen(false);
    setDockSection(null);
    setShortcutsOpen(false);
    setShowControls(false);
  }, [
    terminalError,
    setBuffering,
    setIsPlaying,
    setShowControls,
  ]);

  /** Sleep timer — pause when it fires; clear on Off / unmount / media change. */
  useEffect(() => {
    if (sleepTimerRef.current != null) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    if (sleepMinutes == null || sleepMinutes <= 0) return;

    sleepTimerRef.current = setTimeout(() => {
      sleepTimerRef.current = null;
      const v = videoRef.current;
      userPausedRef.current = true;
      if (v && !v.paused) v.pause();
      setSleepMinutes(null);
      setAutoplayHint(SLEEP_TIMER_PAUSED_MSG);
      setShowControls(true);
    }, sleepMinutes * 60_000);

    return () => {
      if (sleepTimerRef.current != null) {
        clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
    };
  }, [sleepMinutes, setShowControls]);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      // Keep chrome visible while dock/shortcuts are open (avoid mid-interaction dismiss).
      if (dockOpenRef.current || shortcutsOpenRef.current) return;
      if (!videoRef.current?.paused) {
        setShowControls(false);
        setDockOpen(false);
        setDockSection(null);
        setShortcutsOpen(false);
      }
    }, CONTROLS_HIDE_MS);
  }, [setShowControls]);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [resetControlsTimer, isPlaying]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      userPausedRef.current = false;
      void v.play();
    } else {
      userPausedRef.current = true;
      v.pause();
    }
  }, []);

  const seekRelative = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
  }, []);

  const seekTo = useCallback(
    (time: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = time;
      setCurrentTime(time);
    },
    [setCurrentTime]
  );

  const seekToPct = useCallback((pct: number) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = v.duration * pct;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const setVideoVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, val));
    v.muted = val === 0;
  }, []);

  const adjustVolume = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, v.volume + delta));
    v.muted = v.volume === 0;
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* PiP not supported */
    }
  }, []);

  const dismissError = useCallback(() => setError(null), [setError]);

  const handleQualityTargetChange = useCallback(
    (
      target: PlayerQualityTarget,
      announce = true,
      allowUnavailablePreference = false
    ): boolean => {
      const hls = hlsRef.current;
      const dash = dashRef.current;
      const activeLevels = usePlayerStore.getState().levels;

      if (target === "auto") {
        qualityTargetRef.current = target;
        setQualityTarget(target);
        if (hls) {
          applyPreferredHlsQuality(hls, levelsFromHls(hls), "auto");
        } else if (dash) {
          dash.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: true } } },
          } as Parameters<typeof dash.updateSettings>[0]);
        }
        setQuality(-1);
        if (announce) showStatusNotice("Quality set to Auto", 1_800);
        return true;
      }

      const option = buildPlayerQualityOptions({
        sources: displaySources,
        activeSourceId: activeSourceRef.current?.id,
        activeLevels,
        selected: target,
        failedIds: failedSourceIdsRef.current,
        discovering: Boolean(isDiscoveringRef.current),
        actualHeight: usePlayerStore.getState().playingHeight,
      }).find((candidate) => candidate.value === target);

      const replacement = option?.sourceId
        ? orderedSourcesRef.current.find((source) => source.id === option.sourceId)
        : undefined;
      const canCommit =
        option != null &&
        shouldCommitQualityTarget(option, allowUnavailablePreference);
      if (!canCommit) {
        if (allowUnavailablePreference) {
          qualityTargetRef.current = target;
          setQualityTarget(target);
        }
        if (announce) {
          showStatusNotice(
            `${playerQualityLabel(target)} unavailable · playing the best available quality`,
            2_800
          );
        }
        return false;
      }

      qualityTargetRef.current = target;
      setQualityTarget(target);

      if (option.status === "unavailable" || option.status === "searching") {
        return false;
      }

      if (option?.levelIndex != null && hls) {
        const switched = switchHlsLevelSmooth(hls, option.levelIndex);
        setQuality(switched);
        if (announce) {
          showStatusNotice(`Switching to ${playerQualityLabel(target)}`, 1_800);
        }
        return true;
      }

      if (option?.levelIndex != null && dash) {
        dash.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: false } } },
        } as Parameters<typeof dash.updateSettings>[0]);
        dash.setQualityFor("video", option.levelIndex);
        setQuality(option.levelIndex);
        if (announce) {
          showStatusNotice(`Switching to ${playerQualityLabel(target)}`, 1_800);
        }
        return true;
      }

      if (!replacement) return false;
      userSelectedSourceRef.current = true;
      setQuality(-1);
      handleSourceChange(replacement);
      if (announce) {
        showStatusNotice(
          `Switching source for ${playerQualityLabel(target)}`,
          2_400
        );
      }
      return true;
    },
    [
      displaySources,
      handleSourceChange,
      levelsFromHls,
      setQuality,
      showStatusNotice,
    ]
  );

  useEffect(() => {
    if (
      profileQuality == null ||
      userSelectedQualityRef.current ||
      qualityTargetRef.current === profileQuality
    ) {
      return;
    }
    handleQualityTargetChange(profileQuality, false, true);
  }, [profileQuality, handleQualityTargetChange]);

  const handleUserQualityTargetChange = useCallback(
    (target: PlayerQualityTarget) => {
      if (handleQualityTargetChange(target)) {
        userSelectedQualityRef.current = true;
      }
    },
    [handleQualityTargetChange]
  );

  const setSpeedValue = useCallback(
    (speed: number) => {
      const v = videoRef.current;
      if (v) v.playbackRate = speed;
      setSpeed(speed);
      setSavedPlaybackSpeed(speed);
    },
    [setSpeed]
  );

  useEffect(() => {
    const v = videoRef.current;
    const saved = getSavedPlaybackSpeed();
    if (v && saved !== 1) v.playbackRate = saved;
    setSpeed(saved);
    // Persisted volume/mute (task 10a): the store only ever mirrored the video
    // element's own volumechange events, so persisting to the store alone did
    // nothing user-visible — apply it once to the native element on mount.
    if (v) {
      const state = usePlayerStore.getState();
      v.volume = state.volume;
      v.muted = state.isMuted;
    }
  }, [setSpeed]);

  const handleSubtitleChange = useCallback(
    (trackId: number | null) => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (trackId === null) {
        subtitleIntentRef.current = { on: false, lang: null };
        setSubtitlesOn(false);
        setActiveSubtitleId(null);
        if (hls) {
          hls.subtitleTrack = -1;
          hls.subtitleDisplay = false;
        } else if (video) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const t = video.textTracks[i];
            if (t && (t.kind === "subtitles" || t.kind === "captions")) {
              t.mode = "disabled";
            }
          }
        }
        return;
      }
      const trackLang =
        usePlayerStore.getState().subtitleTracks.find((t) => t.id === trackId)?.lang ?? null;
      // Persist intent so it survives resetStream() on the next source switch —
      // otherwise captions silently turn off on every server change.
      subtitleIntentRef.current = { on: true, lang: trackLang };
      setSubtitlesOn(true);
      setActiveSubtitleId(trackId);
      if (hls && hlsHasTrackId(hls.subtitleTracks, trackId)) {
        hls.subtitleTrack = trackId;
        hls.subtitleDisplay = true;
      } else if (video) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const t = video.textTracks[i];
          if (!t || (t.kind !== "subtitles" && t.kind !== "captions")) continue;
          t.mode = i === trackId ? "showing" : "disabled";
        }
      }
    },
    [setSubtitlesOn, setActiveSubtitleId]
  );

  const handleAudioChange = useCallback(
    (trackId: number) => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      setActiveAudioId(trackId);
      const track = usePlayerStore.getState().audioTracks.find((t) => t.id === trackId);
      if (track?.lang) setPreferredAudioLanguage(track.lang);
      if (hls && hlsHasTrackId(hls.audioTracks, trackId)) {
        hls.audioTrack = trackId;
        return;
      }
      const media = video as
        | (HTMLVideoElement & {
            audioTracks?: { length: number; [i: number]: { enabled?: boolean } };
          })
        | null;
      const list = media?.audioTracks;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (t) t.enabled = i === trackId;
        }
      }
    },
    [setActiveAudioId]
  );

  const toggleSubtitles = useCallback(() => {
    const tracks = usePlayerStore.getState().subtitleTracks;

    if (subtitlesOn) {
      handleSubtitleChange(null);
      return;
    }

    // No empty-state chrome: do nothing when the stream has zero subtitle tracks.
    if (tracks.length === 0) return;

    const preferred =
      tracks.find((t) => isEnglishTrack(t.lang, t.name))?.id ?? tracks[0].id;
    handleSubtitleChange(preferred);
  }, [subtitlesOn, handleSubtitleChange]);

  /**
   * Window-level shortcuts (task 5) — previously attached via onKeyDown on the
   * player container, which only fired after an explicit click gave it DOM
   * focus, so shortcuts were dead until the video was clicked. Guarded against
   * typing in form fields and against the settings dock / shortcuts panel
   * being open. Also owns "?" (help toggle) so there is exactly one global
   * handler instead of a second, possibly-inconsistent one.
   */
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || terminalError) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if (isEditable) return;
      if (shortcutsOpenRef.current) {
        if (e.key === "Escape" || e.key === "?" || (e.key === "/" && e.shiftKey)) {
          e.preventDefault();
          setShortcutsOpen(false);
          resetControlsTimer();
        }
        return;
      }
      if (dockOpenRef.current) return;
      // Focus restoration after a modal commonly lands on a player button.
      // Keep activation and D-pad arrows owned by that control, but do not
      // disable global media/fullscreen/help shortcuts merely because a
      // button currently has focus.
      if (
        isInteractivePlayerTarget(target) &&
        (e.key === " " ||
          e.key === "Enter" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        return;
      }
      if (!hasStream) return;

      switch (e.key) {
        case " ":
        case "k":
        case "Enter":
        case "MediaPlayPause":
          e.preventDefault();
          togglePlay();
          break;
        case "MediaPlay": {
          e.preventDefault();
          const video = videoRef.current;
          if (video?.paused) togglePlay();
          break;
        }
        case "MediaPause": {
          e.preventDefault();
          const video = videoRef.current;
          if (video && !video.paused) togglePlay();
          break;
        }
        case "ArrowLeft":
        case "j":
          seekRelative(-10);
          break;
        case "ArrowRight":
        case "l":
          seekRelative(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          toggleMute();
          break;
        case "c":
          toggleSubtitles();
          break;
        case "n":
        case "MediaTrackNext":
          if (hasNextEpisode) onNextEpisode?.();
          break;
        case "?":
          setShortcutsOpen((v) => !v);
          break;
        default:
          // Some Chromium/TV keyboard implementations report Shift+/ as "/"
          // instead of the printable "?". Treat that exact chord as help too.
          if (e.key === "/" && e.shiftKey) {
            setShortcutsOpen((v) => !v);
            break;
          }
          if (/^[0-9]$/.test(e.key)) {
            seekToPct(Number(e.key) / 10);
          }
      }
      resetControlsTimer();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    hasStream,
    togglePlay,
    seekRelative,
    adjustVolume,
    toggleFullscreen,
    toggleMute,
    toggleSubtitles,
    seekToPct,
    hasNextEpisode,
    onNextEpisode,
    resetControlsTimer,
    terminalError,
  ]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartedOnInteractive.current = isInteractivePlayerTarget(e.target);
    if (terminalError || touchStartedOnInteractive.current) {
      touchStart.current = null;
      return;
    }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (
      terminalError ||
      touchStartedOnInteractive.current ||
      isInteractivePlayerTarget(e.target)
    ) {
      touchStartedOnInteractive.current = false;
      touchStart.current = null;
      return;
    }
    touchStartedOnInteractive.current = false;
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_MIN_PX) {
      seekRelative(dx > 0 ? SWIPE_SEEK_SECONDS : -SWIPE_SEEK_SECONDS);
    } else if (Math.abs(dy) > SWIPE_MIN_PX) {
      adjustVolume(dy < 0 ? 0.15 : -0.15);
    } else {
      togglePlay();
    }
    resetControlsTimer();
  };

  const levels = usePlayerStore((s) => s.levels);

  const waitingForSource = !hasStream && (sourcesLoading || !sourcesError);
  const controlsPinned =
    !terminalError && (!hasStream || waitingForSource || showHunting);
  const controlsVisible = !terminalError && (showControls || controlsPinned);

  const qualityTargets = useMemo(
    () =>
      buildPlayerQualityOptions({
        sources: displaySources,
        activeSourceId: activeSource?.id,
        activeLevels: levels,
        selected: qualityTarget,
        failedIds: new Set(failedSourceIds),
        discovering: Boolean(isDiscoveringSources),
        actualHeight: playingHeight,
      }),
    [
      displaySources,
      activeSource?.id,
      levels,
      qualityTarget,
      failedSourceIds,
      isDiscoveringSources,
      playingHeight,
    ]
  );

  const hasAlternateSource = eligiblePlaybackSources(
    orderedSources.filter((source) => source.id !== activeSource?.id),
    failedSourceIdsRef.current
  ).length > 0;
  const isExhausted = error === ALL_SOURCES_FAILED_MSG;
  const errorActions: PlayerErrorAction[] = [
    ...(hasAlternateSource
      ? [
          {
            label: "Next source",
            icon: <RefreshCw className="h-3 w-3" />,
            onClick: () => {
              if (!tryNextSource()) setError(ALL_SOURCES_FAILED_MSG);
            },
          },
        ]
      : []),
    ...(onRetrySources
      ? [
          {
            label: "Try again",
            icon: <RefreshCw className="h-3 w-3" />,
            onClick: handleRetryFull,
            variant: (hasAlternateSource ? "secondary" : "primary") as PlayerErrorAction["variant"],
          },
        ]
      : []),
    ...(onBack
      ? [{ label: "Back", icon: <ArrowLeft className="h-3 w-3" />, onClick: onBack, variant: "secondary" as const }]
      : []),
  ];
  const sourcesErrorActions: PlayerErrorAction[] = [
    ...(onRetrySources
      ? [{ label: "Try again", icon: <RefreshCw className="h-3 w-3" />, onClick: handleRetryFull }]
      : []),
    ...(onBack
      ? [{ label: "Back", icon: <ArrowLeft className="h-3 w-3" />, onClick: onBack, variant: "secondary" as const }]
      : []),
  ];

  return (
    <div
      ref={containerRef}
      className="group/player relative h-full min-h-0 w-full cursor-none bg-black select-none data-[ui=1]:cursor-auto"
      data-ui={
        controlsVisible || showHunting || !!error || !!sourcesError
          ? "1"
          : "0"
      }
      onMouseMove={resetControlsTimer}
      onMouseLeave={() => {
        if (dockOpenRef.current || shortcutsOpenRef.current) return;
        if (isPlaying) {
          setShowControls(false);
          closeDock();
        }
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      tabIndex={0}
    >
      <video
        ref={videoRef}
        data-playback-source-id={activeSource?.id || undefined}
        data-playback-source-provider={activeSource?.provider || undefined}
        poster={poster || undefined}
        // hls.js/dash.js manage their own MSE buffering regardless of this
        // hint; it matters for the native/progressive-mp4 path (no ladder,
        // no in-source ABR) where smoothness = the browser's own
        // resource-fetch algorithm buffering ahead aggressively.
        preload="auto"
        className="main-player absolute inset-0 block h-full w-full bg-black object-contain"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
        onClick={() => {
          if (terminalError) return;
          if (dockOpen) closeDock();
          if (autoplayHint === MUTED_AUTOPLAY_HINT) {
            const v = videoRef.current;
            if (v) v.muted = false;
            setAutoplayHint(null);
            return;
          }
          togglePlay();
        }}
        onDoubleClick={() => {
          if (!terminalError) toggleFullscreen();
        }}
        playsInline
      />

      <LoadingScreen
        visible={showHunting}
        serverName={huntingName}
        title={title}
        backdropUrl={poster}
        sourceCount={Math.max(sourceCount, healthySourceCount)}
        discovering={Boolean(isDiscoveringSources)}
        status={resumeNotice ?? loadingStatus}
      />

      {failoverNotice && (
        <div
          className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/25 bg-black/75 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-amber-300/90" />
          <span>{failoverNotice}</span>
        </div>
      )}

      {!failoverNotice && showSwitchingChip && (
        <div
          className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/80" />
          <span>
            Switching to {huntingName}…
            {needsTranscode ? " Preparing stream, this can take a few seconds." : ""}
          </span>
        </div>
      )}

      {/* Change 3: non-blocking new-source nudge — does not interrupt playback. */}
      {!failoverNotice && !showSwitchingChip && newSourceNotice && (
        <div
          className="absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <span>{NEW_SOURCE_NOTICE_MSG}</span>
          <button
            type="button"
            onClick={() => {
              setNewSourceNotice(false);
              setDockOpen(true);
              setDockSection("server");
              setShowControls(true);
              resetControlsTimer();
            }}
            className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-white/25"
          >
            Servers
          </button>
          <button
            type="button"
            onClick={() => setNewSourceNotice(false)}
            className="rounded-full p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Post-first-frame mid-watch stall only — the pre-first-frame equivalent
          now lives inside the unified LoadingScreen overlay's status text above. */}
      {showBufferingChip && !newSourceNotice && (
        <div
          className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/80" />
          <span>
            Buffering
            {playingHeight > 0
              ? ` — ${formatResolutionLabel(playingHeight)}`
              : huntingName && huntingName !== "servers"
                ? ` — ${huntingName}`
                : ""}
          </span>
        </div>
      )}

      {/* Resuming-from indicator — visible once the full-bleed overlay above has
          lifted (while it's up, this is folded into its own status text instead;
          see the `status={resumeNotice ?? loadingStatus}` prop on LoadingScreen). */}
      {!showHunting && !failoverNotice && !showSwitchingChip && !newSourceNotice && resumeNotice && (
        <div
          className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <span>{resumeNotice}</span>
        </div>
      )}

      {autoplayHint === MUTED_AUTOPLAY_HINT && isPlaying && !showSwitchingChip && (
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = false;
            setAutoplayHint(null);
          }}
          className="absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md hover:bg-black/80"
        >
          {MUTED_AUTOPLAY_HINT}
        </button>
      )}

      {!hasStream && sourcesError && !sourcesLoading && (
        <PlayerErrorCard
          headline={sourcesError}
          subtext="You can try again or go back."
          actions={sourcesErrorActions}
        />
      )}

      {/* Exhaustion (all sources failed) gets no dismiss — the card IS the
          only path forward. Other terminal errors (browser can't decode this
          stream type) keep a dismiss since the poster/video underneath is at
          least visible and inert, not actively broken. */}
      {error && (
        <PlayerErrorCard
          headline={isExhausted ? "All servers are unavailable right now" : error}
          subtext={
            isExhausted
              ? "We tried every server we could find for this title."
              : "Try another server or go back."
          }
          actions={errorActions}
          onDismiss={isExhausted ? undefined : dismissError}
        />
      )}

      {/* Pause: white circle play (LordFlix) — no helper text under the button */}
      {hasStream && !isPlaying && !buffering && !error && !showHunting && (
        <button
          type="button"
          onClick={() => {
            if (dockOpen) closeDock();
            togglePlay();
          }}
          className="absolute inset-0 z-[5] flex items-center justify-center bg-black/25"
          aria-label="Play"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full border-0 bg-white/95 shadow-lg transition-all duration-150 hover:scale-[1.08] hover:bg-white">
            <Play className="ml-[3px] h-6 w-6 fill-[#111] text-[#111]" aria-hidden />
          </span>
        </button>
      )}

      {/* Title + Paused overlaid on video (LordFlix) — stays while paused, above controls */}
      {!isPlaying && hasStream && !showHunting && !error && (
        <div
          className="pointer-events-none absolute z-10 max-w-md animate-in fade-in duration-300"
          style={{ bottom: 72, left: 24 }}
        >
          <h3 className="m-0 text-base font-semibold text-white drop-shadow-md">{title}</h3>
          <p className="m-0 mt-0.5 text-[0.8rem] leading-relaxed text-white/50 drop-shadow">
            {autoplayHint === SLEEP_TIMER_PAUSED_MSG ? autoplayHint : "Paused"}
          </p>
        </div>
      )}

      {!terminalError && swipeHint !== "hidden" && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center px-4 transition-opacity duration-500 ${
            swipeHint === "visible" ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 text-[11px] font-medium text-white/70 backdrop-blur-sm">
            <ArrowLeftRight className="h-3 w-3" />
            <span>Swipe to seek</span>
            <span className="text-white/35">·</span>
            <ArrowUpDown className="h-3 w-3" />
            <span>Swipe up/down for volume</span>
          </div>
        </div>
      )}

      {!terminalError && <SkipIntroButton onSkip={seekTo} />}

      {!terminalError && <PlayerControls
        title={title}
        mediaType={mediaType}
        sources={displaySources}
        activeSourceId={activeSource?.id ?? ""}
        onSourceChange={handleUserSourceChange}
        alwaysShowControls={controlsPinned}
        onTogglePlay={togglePlay}
        onSeekRelative={seekRelative}
        onSeekTo={seekTo}
        onToggleMute={toggleMute}
        onSetVolume={setVideoVolume}
        onToggleFullscreen={toggleFullscreen}
        onTogglePip={togglePip}
        onToggleSettings={(section = "quality") => {
          if (dockOpen && dockSection === section) {
            closeDock();
          } else {
            setDockOpen(true);
            setDockSection(section);
            setShowControls(true);
            resetControlsTimer();
          }
        }}
        settingsOpen={dockOpen}
        onToggleShortcuts={() => {
          if (shortcutsOpen) {
            setShortcutsOpen(false);
          } else {
            setShortcutsOpen(true);
            resetControlsTimer();
          }
        }}
        shortcutsOpen={shortcutsOpen}
        dockSection={dockSection}
        onDockSectionChange={setDockSection}
        onCloseDock={closeDock}
        qualityTargets={qualityTargets}
        activeQualityTarget={qualityTarget}
        onQualityTargetChange={handleUserQualityTargetChange}
        onSubtitleChange={handleSubtitleChange}
        onAudioChange={handleAudioChange}
        onSetSpeed={setSpeedValue}
        hasNextEpisode={hasNextEpisode}
        onNextEpisode={onNextEpisode}
        isDiscoveringSources={isDiscoveringSources}
        failedSourceIds={failedSourceIds}
        onBack={onBack}
        tvId={tvId}
        tvSeasons={tvSeasons}
        tvSeason={tvSeason}
        tvEpisode={tvEpisode}
        onSelectEpisode={onSelectEpisode}
        sleepMinutes={sleepMinutes}
        onSleepMinutesChange={setSleepMinutes}
      />}
    </div>
  );
}
