"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import type { PlaybackSource, SourceProbeMetrics } from "@/lib/playback/types";
import {
  probeSameOriginSource,
  runBoundedHealthProbes,
} from "@/lib/playback/background-health-probe";
import { getServerDisplayName } from "@/lib/playback/server-names";
import {
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
  isSourcePlayableHere,
  sourceDelivery,
  findDirectDebridAlternative,
  HD_FLOOR_HEIGHT,
} from "@/lib/playback/source-quality";
import { dedupePlaybackSources } from "@/lib/playback/source-identity";
import { isPoisonStreamUrl } from "@/lib/playback/poison-url";
import { firstFrameWallMs } from "@/lib/playback/first-frame-wall";
import { decidePlayback } from "@/lib/playback/decide-playback";
import { selectActiveSource } from "@/lib/playback/select-active-source";
import { buildRemuxUrl } from "@/lib/playback/remux-url";
import {
  HLS_WORKER_PATH,
  attemptAutoplay,
  bufferedAheadSeconds,
  classifyPlaybackUrl,
  freezeLastVideoFrame,
  hlsWorkerSupportedHere,
  isSessionExpiredError,
  preferNativeHls,
} from "@/lib/playback/player-engine";
import {
  formatClock,
  mapAudioTracks,
  mapHlsLevels,
  mapNativeAudioTracks,
  mapNativeTextTracks,
  mapSubtitleTracks,
} from "@/lib/playback/player-media";
import { usePlaybackSession } from "@/hooks/use-playback-session";
import {
  findLateFourKSource,
  wantsFourKDiscovery,
} from "@/lib/playback/late-fourk";
import {
  PLAYBACK_FAST_4K_ENABLED,
  PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED,
  PLAYBACK_TRACK_POLICY_ENABLED,
} from "@/lib/playback/features";
import {
  isLogicalTimeSeekable,
  logicalDuration,
  normalizeRemuxStart,
  toLogicalTime,
  toMediaTime,
} from "@/lib/playback/remux-timeline";
import { prewarmRemuxPosition } from "@/lib/playback/remux-prewarm";

import { activeBufferProfile } from "@/lib/playback/device-profile";
import { warmDecodeCapabilities } from "@/lib/playback/decode-capability";
import { assessMediaDuration } from "@/lib/playback/media-duration";
import { emitPlayerFeedback } from "@/lib/playback/player-feedback";
import {
  normalizeTrackLanguage,
  selectAudioTrack,
  selectSubtitleTrack,
  type AudioTrackSelection,
} from "@/lib/playback/track-selection";
import {
  SourceAttemptController,
  type SourceAttemptToken,
} from "@/lib/playback/source-attempt";
import { preresolvePlayback } from "@/lib/playback-preresolve";
import { shouldPrefetchNextEpisode } from "@/lib/playback/next-episode-prefetch";
import {
  isRemoteBackEvent,
  isTvLikeDevice,
  moveSpatialFocus,
  type SpatialDirection,
} from "@/lib/tv-navigation";
import {
  adaptiveRecoveryPhase,
  effectiveLevelHeight,
  findBestLevelForTarget,
  findFloorBitrateKbps,
  findLowerLevelIndexForHeight,
  findMinLevelIndexForHeight,
  hlsPromotionTargetHeight,
  maxLevelHeight,
  pickDefaultQualityIndex,
  pickHighestLevelIndex,
  pickStartLevelIndex,
  levelsFromQualityRungs,
} from "@/lib/playback/hls-quality";
import {
  getPreferredProvider,
  getPreferredQualityHeight,
  getPreferredAudioLanguage,
  getAudioPreference,
  getFourKStartupPreference,
  getSubtitlePreference,
  getSavedPlaybackSpeed,
  setPreferredProvider,
  setPreferredAudioLanguage,
  setSavedPlaybackSpeed,
  getQualityFloorPolicy,
  type QualityFloorPolicy,
} from "@/lib/player-preferences";
import type {
  AudioPreference,
  FourKStartupPreference,
  SubtitlePreference,
} from "@/lib/profile-preferences";
import Hls from "hls.js";
import type { MediaPlayerClass } from "dashjs";
import { Play, Loader2, RefreshCw, X, ArrowLeft, ArrowLeftRight, ArrowUpDown } from "lucide-react";
import { usePlayerStore, type MediaTrack, type QualityLevel } from "@/stores/player-store";
import { PlayerControls } from "@/components/player-controls";
import { LoadingScreen } from "@/components/player/LoadingScreen";
import { premiumSourceCount } from "@/lib/playback/bloom-visuals";
import { useHoverPreview } from "@/hooks/use-hover-preview";
import { PlayerErrorCard, type PlayerErrorAction } from "@/components/player/PlayerErrorCard";
import { SkipIntroButton } from "@/components/player/SkipIntroButton";
import type { DockSection } from "@/components/player-dock";
import {
  alreadyAtQualityTarget,
  buildPlayerQualityOptions,
  normalizePlayerQualityHeight,
  pickQualityRungUrl,
  qualityLabel as playerQualityLabel,
  type PlayerQualityTarget,
} from "@/lib/playback/quality-router";

const CONTROLS_HIDE_MS = 3000;
const SWIPE_SEEK_SECONDS = 10;
const SWIPE_MIN_PX = 40;
const SWIPE_HINT_VISIBLE_MS = 2200;
const SWIPE_HINT_FADE_MS = 500;
const REMUX_SEEK_DEBOUNCE_MS = 160;
const REMUX_SEEK_NOTICE_MS = 12_000;
const ALL_SOURCES_FAILED_MSG =
  "No playable server for this title right now. Retry full for a fresh resolve.";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenContainer = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function isInteractivePlayerTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, select, textarea, [role='button'], [role='dialog'], [role='slider']"
      )
    )
  );
}

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
/** Pre-roll seconds the bloom's core ring treats as a full buffer. */
const BLOOM_TARGET_BUFFER_S = 8;
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
const ADAPTIVE_FLOOR_MIN_HEIGHT = 480;
/**
 * How low (relative to current) to drop per adaptive step. Each sustained stall
 * drops to the next rung at-or-below (current × 0.6), floor at ADAPTIVE_FLOOR_MIN_HEIGHT.
 */
const ADAPTIVE_DOWN_STEP_RATIO = 0.6;
/**
 * Buffer health (seconds ahead of playhead) above which we attempt to climb
 * back toward the floor / Auto after a downshift. Matches Netflix's
 * "buffer recovered, ramp quality up" heuristic.
 */
const ADAPTIVE_CLIMB_BACK_BUFFER_S = 12;
/** Buffer below this (seconds) while stalled is the trigger to downshift. */
const ADAPTIVE_STARVATION_BUFFER_S = 2;
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
const HLS_HARD_HTTP_CODES = new Set([403, 404, 410, 502, 503, 520, 521, 522, 524]);
const REMUX_BUSY_HTTP_CODES = new Set([429, 502, 503]);
const FRAG_TIMEOUT_FAILOVER_COUNT = 3;
/** If play never advances past t≈0 after load, fail over (stuck Aether/PNG ads). */
/** Cold start: allow large pure-media level fetch after multi-variant master (R10). */
const HLS_ZERO_PROGRESS_FAIL_MS = 22_000;
/** Mid-title resume: extra room for the seek + first fragment after a CDN hop. */
const HLS_ZERO_PROGRESS_FAIL_RESUME_MS = 32_000;
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

/** Prefer the decoded raster over a source/manifest 4K label. */
function pictureHeightFromElement(
  video: HTMLVideoElement | null,
  fallback = 0
): number {
  if (!video) return fallback;
  const decoded = decodedQualityHeight(video.videoWidth, video.videoHeight);
  return decoded > 0 ? decoded : fallback;
}
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
 * One reachability check against a same-origin source URL. Cross-origin opaque
 * GETs are intentionally excluded by the caller: they expose no trustworthy
 * status and can compete with first-frame/4K bandwidth.
 */
async function probeSourceReachabilityCached(
  url: string,
  signal: AbortSignal
): Promise<SourceProbeMetrics | null> {
  const now = Date.now();
  const cached = bgHealthProbeCache.get(url);
  if (cached && cached.expiresAt > now) return cached.probe;
  const probe = await probeSameOriginSource(url, {
    timeoutMs: BG_HEALTH_PROBE_TIMEOUT_MS,
    signal,
    speedScore: speedScoreFromLatencyMs,
  });
  if (!probe) return null;
  bgHealthProbeCache.set(url, { probe, expiresAt: now + BG_HEALTH_PROBE_CACHE_TTL_MS });
  return probe;
}

interface Props {
  sources: PlaybackSource[];
  sourcesLoading?: boolean;
  sourcesError?: string | null;
  onRetrySources?: () => void;
  isDiscoveringSources?: boolean;
  /** Authenticated profile default from the playback response. */
  profileQuality?: PlayerQualityTarget;
  profileAudioPreference?: AudioPreference;
  profileAudioLanguage?: string;
  profileSubtitlePreference?: SubtitlePreference;
  profileFourKStartup?: FourKStartupPreference;
  remuxAvailable?: boolean;
  /** TMDB original language, used only to choose among tracks actually exposed. */
  originalLanguage?: string | null;
  /** Changes when a cache-bypassing roster recovery returns. */
  refreshNonce?: number;
  /** Progressive source count for loading status. */
  sourceCount?: number;
  poster?: string | null;
  /** 2:3 title poster for the loading card. Backdrop stays on `poster`. */
  artwork?: string | null;
  title: string;
  mediaType?: "movie" | "tv";
  /** TMDB id of the title — used to build the transcode URL for HEVC/AV1 sources
   * the browser can't decode natively (routed through /api/transcode). */
  tmdbId?: number;
  initialTime?: number;
  onProgress?: (current: number, duration: number) => void;
  onEnded?: () => void;
  hasNextEpisode?: boolean;
  /** TMDB runtime in seconds; used only while the stream's own duration is
   * still growing (see `durationProvisional`). 0 = unknown. */
  fallbackDurationS?: number;
  onNextEpisode?: () => void;
  /** Preload next episode sources (TV binge). */
  nextEpisodeTarget?: { season: number; episode: number } | null;
  /** Lordflix top-bar back */
  onBack?: () => void;
  /** Click the player title to open the movie/show info page. */
  onTitleClick?: () => void;
  /** TV episode picker (optional) */
  tvId?: number;
  tvSeasons?: { season_number: number; name?: string; episode_count?: number }[];
  tvSeason?: number;
  tvEpisode?: number;
  onSelectEpisode?: (season: number, episode: number) => void;
}











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
 * Stall recovery. Two policies, switchable in Settings (quality-floor-policy):
 *
 *  - "absolute" (old brand behavior): re-affirm the 1080 floor unconditionally.
 *    Bandwidth starvation buffers at the floor rather than dropping a rung.
 *
 *  - "adaptive" (default, Netflix/YouTube): under sustained starvation (buffer
 *    < ADAPTIVE_STARVATION_BUFFER_S) drop one rung toward ADAPTIVE_FLOOR_MIN_HEIGHT
 *    to keep video playing; once buffer recovers past ADAPTIVE_CLIMB_BACK_BUFFER_S,
 *    hand control back to Auto ABR so it can climb to 4K again. This is the
 *    "drop quality to avoid a stall, then ramp back up" behavior real streaming
 *    services use.
 *
 * Never force-pin `currentLevel` while Auto is active (`currentLevel === -1`) —
 * that would permanently disable ABR climb to 4K. Auto gets load/nextLevel/
 * startLevel nudges; fixed prefs re-pin currentLevel.
 */
export interface AdaptiveRecoverContext {
  /** Seconds of video buffered ahead of the playhead (-1 = unknown). */
  bufferAheadS: number;
  /** "adaptive" allows downshift; "absolute" never does. */
  policy: QualityFloorPolicy;
}

function pickAdaptiveDownshiftTarget(
  levelList: QualityLevel[],
  curH: number
): number {
  // Drop to the highest rung at-or-below (curH × step ratio), floored at minimum.
  const target = Math.max(
    ADAPTIVE_FLOOR_MIN_HEIGHT,
    Math.floor(curH * ADAPTIVE_DOWN_STEP_RATIO)
  );
  return findLowerLevelIndexForHeight(
    levelList,
    curH,
    target,
    ADAPTIVE_FLOOR_MIN_HEIGHT
  );
}

function recoverHlsAdaptive(
  hls: Hls,
  ctx: AdaptiveRecoverContext,
  preferredHeight: PlayerQualityTarget = getPreferredQualityHeight()
): void {
  const levelList = mapHlsLevels(hls);
  const floorIdx = findMinLevelIndexForHeight(levelList, HLS_MIN_HEIGHT);
  const ladderMax = maxLevelHeight(levelList);
  const cur = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
  const curLevel = levelList.find((l) => l.index === cur);
  const curH = curLevel ? effectiveLevelHeight(curLevel) : 0;
  if (preferredHeight !== "auto") {
    const fixedIdx = findBestLevelForTarget(levelList, preferredHeight);
    if (fixedIdx >= 0 && fixedIdx !== cur) {
      hls.capLevelToPlayerSize = false;
      hls.autoLevelCapping = -1;
      hls.nextLevel = fixedIdx;
      hls.loadLevel = fixedIdx;
      hls.nextLoadLevel = fixedIdx;
    }
    try {
      hls.startLoad();
    } catch {
      /* ignore */
    }
    return;
  }
  // A fixed menu choice is contractual: recovery may reload it, but must not
  // silently turn it back into Auto or move to another rung.
  const adaptive = ctx.policy === "adaptive" && preferredHeight === "auto";
  const starving =
    ctx.bufferAheadS >= 0 && ctx.bufferAheadS < ADAPTIVE_STARVATION_BUFFER_S;
  const recoveryPhase = adaptiveRecoveryPhase(
    ctx.policy,
    ctx.bufferAheadS,
    ADAPTIVE_CLIMB_BACK_BUFFER_S
  );

  // CLIMB-BACK: buffer recovered and we're below floor/locked low → release to
  // Auto ABR so it can climb toward the floor / 4K again. Only under adaptive.
  if (
    adaptive &&
    curH > 0 &&
    curH < HLS_MIN_HEIGHT &&
    recoveryPhase === "climb"
  ) {
    hls.capLevelToPlayerSize = false;
    hls.autoLevelCapping = -1;
    if (hls.autoLevelEnabled) {
      if (floorIdx >= 0) hls.nextAutoLevel = floorIdx;
    } else if (floorIdx >= 0) {
      hls.currentLevel = -1;
      hls.nextLevel = -1;
      hls.nextAutoLevel = floorIdx;
    }
    try {
      hls.startLoad();
    } catch {
      /* ignore */
    }
    return;
  }

  // DOWNSHIFT: adaptive + genuinely starving + a lower rung exists → drop one.
  if (
    adaptive &&
    starving &&
    curH > ADAPTIVE_FLOOR_MIN_HEIGHT &&
    curH > 0
  ) {
    const downIdx = pickAdaptiveDownshiftTarget(levelList, curH);
    if (downIdx >= 0 && downIdx !== cur) {
      hls.capLevelToPlayerSize = false;
      // One-fragment forced Auto choice. nextLevel/loadLevel would set
      // manualLevel and could strand "Auto" at the recovery rung forever.
      hls.nextAutoLevel = downIdx;
      try {
        hls.startLoad();
      } catch {
        /* ignore */
      }
      return;
    }
  }

  // FLOOR-AFFIRM is reserved for the explicit absolute policy. Adaptive Auto
  // stays low until the recovered-buffer branch above releases it to ABR.
  if (
    recoveryPhase === "floor" &&
    floorIdx >= 0 &&
    ladderMax >= HLS_MIN_HEIGHT &&
    curH > 0 &&
    curH < HLS_MIN_HEIGHT * 0.95
  ) {
    hls.capLevelToPlayerSize = false;
    hls.nextLevel = floorIdx;
    hls.loadLevel = floorIdx;
    hls.nextLoadLevel = floorIdx;
    if (hls.currentLevel >= 0) hls.currentLevel = floorIdx;
    else hls.startLevel = floorIdx;
  }

  try {
    hls.startLoad();
  } catch {
    /* ignore */
  }
}

/**
 * Stall-recovery entry point for every caller.
 *
 * This used to hardcode `bufferAheadS: -1` ("unknown"), and it was the ONLY
 * caller of `recoverHlsAdaptive` — so the DOWNSHIFT branch, which requires
 * `bufferAheadS >= 0` to detect starvation, could never be reached from
 * anywhere. The `"adaptive"` floor policy is the shipped default
 * (DEFAULT_FLOOR_POLICY in player-preferences.ts) and is documented as
 * Netflix-style "drop a rung to keep playing, then climb back", but with no
 * buffer reading it silently collapsed into the `"absolute"` behavior: hold
 * 1080p and buffer through the starvation instead.
 *
 * Passing the real forward-buffer measurement is what makes the setting mean
 * something. `bufferedAheadSeconds` already exists and returns -1 on failure,
 * which preserves the old floor-affirm path when the reading is unavailable.
 * Users who prefer the hold-1080p-forever behavior still have it — that is
 * exactly what the "absolute" policy in Settings selects.
 */
function recoverHlsPlayback(
  hls: Hls,
  video: HTMLVideoElement | null,
  preferredHeight: PlayerQualityTarget = getPreferredQualityHeight()
): void {
  recoverHlsAdaptive(
    hls,
    {
      bufferAheadS: video ? bufferedAheadSeconds(video) : -1,
      policy: getQualityFloorPolicySafe(),
    },
    preferredHeight
  );
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
  hls.startLevel = levelIndex;
  hls.nextLevel = levelIndex;
  hls.loadLevel = levelIndex;
  hls.nextLoadLevel = levelIndex;
  hls.currentLevel = levelIndex;
  return levelIndex;
}

/**
 * Manual mid-play switch without `currentLevel`: keep the decoded buffer and
 * move on the next fragment boundary. This avoids the time reset/black flash
 * seen on Cineby's cross-rung switches while still locking future loads.
 */
function switchHlsLevelSmooth(hls: Hls, levelIndex: number): number {
  if (levelIndex < 0) return -1;
  hls.capLevelToPlayerSize = false;
  hls.autoLevelCapping = -1;
  hls.loadLevel = levelIndex;
  hls.nextLoadLevel = levelIndex;
  return levelIndex;
}

/**
 * Always force ≥1080 immediately. "Auto" = ABR only among 1080/4K, never below.
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
    // currentLevel/nextLevel stay -1 so ABR can climb to 4K. Seed only
    // startLevel/loadLevel at lowest >=1080 (never absolute max / 4K default).
    // Floor enforcement mid-play uses nextLevel in LEVEL_SWITCHING (smooth,
    // non-flushing) — never currentLevel unless a fixed user pick requires it.
    hls.autoLevelCapping = -1;
    hls.capLevelToPlayerSize = false;
    const defaultIdx = pickDefaultQualityIndex(levels);
    const idx = defaultIdx >= 0 ? defaultIdx : findBestLevelForTarget(levels, HLS_MIN_HEIGHT);
    if (idx >= 0) {
      hls.startLevel = idx;
      hls.loadLevel = idx;
    }
    hls.nextLevel = -1;
    hls.currentLevel = -1;
    return -1;
  }

  if (typeof prefRaw === "number" && prefRaw >= 2160) {
    return forceHlsLevel(hls, pickHighestLevelIndex(levels));
  }

  const targetH = prefHeight;
  let idx = findBestLevelForTarget(levels, targetH);
  // Sub-HD-only ladder (pickDefaultQualityIndex = -1): still force best available.
  if (idx < 0) idx = findMinLevelIndexForHeight(levels, 0);
  if (idx < 0) idx = pickStartLevelIndex(levels, "auto");
  return forceHlsLevel(hls, idx);
}

/**
 * If playback ever dips below 1080 (e.g. a brief ABR misfire before the
 * LEVEL_SWITCHING/LEVEL_SWITCHED guards catch it), snap back to the floor —
 * UNLESS the adaptive policy is active AND we're currently starving (buffer
 * < ADAPTIVE_STARVATION_BUFFER_S), in which case the downshift is intentional
 * and we let it hold until buffer recovers (recoverHlsAdaptive handles climb).
 *
 * For the "absolute" policy this always snaps back unconditionally (the old
 * brand behavior). bufferAheadS < 0 (unknown) is treated as not-starving so the
 * default path preserves the original snap-back for callers without buffer info.
 */
function maybePromoteHlsQuality(
  hls: Hls,
  levels: QualityLevel[],
  _video: HTMLVideoElement,
  ctx?: AdaptiveRecoverContext,
  preferredHeight: PlayerQualityTarget = getPreferredQualityHeight()
): number | null {
  if (!levels.length) return null;
  const policy = ctx?.policy ?? getQualityFloorPolicySafe();
  if (preferredHeight === "auto" && policy === "adaptive") return null;
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

  const idx = findBestLevelForTarget(levels, targetH);
  if (idx < 0 || idx === curIdx) return null;
  hls.autoLevelCapping = -1;
  return forceHlsLevel(hls, idx);
}

/** Forward-buffer health in seconds from the <video> element's buffered ranges. */
function mapDashLevels(player: MediaPlayerClass): QualityLevel[] {
  const bitrateList = player.getBitrateInfoListFor("video") ?? [];
  return bitrateList.map((info) => ({
    height: info.height,
    width: info.width,
    index: info.qualityIndex,
    bitrate: info.bitrate,
  }));
}

function pickPreferredAudioId(
  hls: Hls,
  selection: AudioTrackSelection
): number {
  const match = selectAudioTrack(
    hls.audioTracks.map((track, index) => ({
      id: typeof track.id === "number" ? track.id : index,
      lang: track.lang,
      name: track.name,
      default: track.default,
    })),
    selection
  );
  if (match) return match.id;
  const first = hls.audioTracks[0];
  if (first && typeof first.id === "number") return first.id;
  return 0;
}

function pickPreferredSubtitle(
  tracks: readonly MediaTrack[],
  wantedLanguage: string | null
): MediaTrack | null {
  const wanted = normalizeTrackLanguage(wantedLanguage);
  if (wanted && wanted !== "en") {
    const exact = tracks.find(
      (track) => normalizeTrackLanguage(track.lang) === wanted
    );
    if (exact) return exact;
  }
  return selectSubtitleTrack(tracks, "english") as MediaTrack | null;
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
  profileAudioPreference,
  profileAudioLanguage,
  profileSubtitlePreference,
  profileFourKStartup,
  remuxAvailable = true,
  originalLanguage,
  refreshNonce,
  sourceCount = 0,
  poster,
  artwork,
  title,
  mediaType,
  tmdbId,
  initialTime,
  onProgress,
  onEnded,
  hasNextEpisode,
  fallbackDurationS = 0,
  onNextEpisode,
  onTitleClick,
  nextEpisodeTarget = null,
  onBack,
  tvId,
  tvSeasons,
  tvSeason,
  tvEpisode,
  onSelectEpisode,
}: Props) {
  const playbackSession = usePlaybackSession();
  const userSelectedAudioRef = useRef(false);
  const manualAudioTrackRef = useRef<{
    sourceId: string;
    trackId: number;
    lang: string | null;
  } | null>(null);
  const audioSelectionRef = useRef<AudioTrackSelection>({
    preference: profileAudioPreference ?? getAudioPreference(),
    originalLanguage,
    preferredLanguage: profileAudioLanguage ?? getPreferredAudioLanguage(),
  });
  useEffect(() => {
    if (userSelectedAudioRef.current) return;
    audioSelectionRef.current = {
      preference: profileAudioPreference ?? getAudioPreference(),
      originalLanguage,
      preferredLanguage: profileAudioLanguage ?? getPreferredAudioLanguage(),
    };
  }, [profileAudioPreference, profileAudioLanguage, originalLanguage]);
  const subtitlePreferenceRef = useRef<SubtitlePreference>(
    profileSubtitlePreference ?? getSubtitlePreference()
  );
  subtitlePreferenceRef.current =
    profileSubtitlePreference ?? getSubtitlePreference();
  const fourKStartupRef = useRef<FourKStartupPreference>(
    profileFourKStartup ?? getFourKStartupPreference()
  );
  fourKStartupRef.current = profileFourKStartup ?? getFourKStartupPreference();
  const remuxAvailableRef = useRef(remuxAvailable);
  remuxAvailableRef.current = remuxAvailable;
  const fragTimeoutCountsRef = useRef(new Map<string, number>());
  const [activeSource, setActiveSource] = useState<PlaybackSource | null>(null);
  const [sourceReloadGeneration, setSourceReloadGeneration] = useState(0);
  const orderedSources = useMemo(() => {
    // Full roster for switching — do not strip unprobed or probe-failed rows.
    // Auto-pick / failover still prefer probe.ok via sortSourcesForPicker + pickDefault.
    const deduped = dedupePlaybackSources(sources);
    return sortSourcesForPicker(deduped);
  }, [sources]);
  const [failedSourceIds, setFailedSourceIds] = useState<string[]>([]);
  const failedSourceIdsRef = useRef<Set<string>>(new Set());
  const resumeAtRef = useRef(0);
  const initialTimeAppliedRef = useRef(false);
  const initialRemuxStart = PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED
    ? normalizeRemuxStart(initialTime ?? 0, fallbackDurationS)
    : 0;
  const [remuxStartAtSeconds, setRemuxStartAtSeconds] = useState(initialRemuxStart);
  const remuxStartAtRef = useRef(initialRemuxStart);
  const remuxTimelineActiveRef = useRef(false);
  const remuxSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remuxSeekAbortRef = useRef<AbortController | null>(null);
  const remuxSeekGenerationRef = useRef(0);
  const pendingRemuxSeekTargetRef = useRef<number | null>(null);
  const remuxRollbackRef = useRef<{
    sourceId: string;
    startAtSeconds: number;
    logicalTime: number;
    targetSeconds: number;
    confirming?: boolean;
  } | null>(null);
  const prevSourceCount = useRef(0);
  /** User picked a server in the dock/settings — never auto-upgrade over that. */
  const userSelectedSourceRef = useRef(false);
  /** A per-watch quality click wins over a later progressive profile response. */
  const userSelectedQualityRef = useRef(false);
  /** At most one Luna→fast CDN auto-upgrade per watch session (pre-first-frame). */
  const autoUpgradedRef = useRef(false);
  const lateFourKAttemptedRef = useRef<Set<string>>(new Set());
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
  /**
   * Whether the media element itself is currently faulted.
   *
   * This used to be read straight off `videoRef.current.error` during render,
   * which is not reactive: the element can fault at any time and nothing would
   * re-render to notice. Now the element's own "error" event records it, so
   * the value is both correct and observed at the moment it changes. Cleared
   * on every new source attempt and on title change.
   */
  const [mediaFaulted, setMediaFaulted] = useState(false);
  /**
   * True while the stream's `duration` is still growing.
   *
   * A remux is produced live: ffmpeg writes an EVENT playlist segment by
   * segment, so `video.duration` reports HOW MUCH HAS BEEN REMUXED, not how
   * long the title is. Measured on a 24-minute episode 20 seconds in:
   * duration read 491.9s. Anything that divides by duration is wrong until the
   * playlist closes — resume progress would be saved at several times the real
   * percentage, and the end-of-episode card would appear a long way from the
   * end.
   *
   * It resolves itself: the remux runs at 4x realtime, so the playlist gains
   * its `#EXT-X-ENDLIST` (hls.js: `details.live === false`) roughly a quarter
   * of the way in, long before either of those things is needed. Until then
   * both are suppressed rather than computed from a number known to be wrong.
   */
  const setDurationProvisional = usePlayerStore((st) => st.setDurationProvisional);
  /** True only after intentional user pause — do not auto-resume after underrun. */
  const userPausedRef = useRef(false);
  /** Mid-watch source switch / failover — compact chip only, keep last frame. */
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);
  const [remuxPacking, setRemuxPacking] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
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
    () =>
      orderedSources.filter(
        (s) =>
          s.verified !== false &&
          s.probe?.ok !== false &&
          !failedSourceIds.includes(s.id)
      ).length,
    [orderedSources, failedSourceIds]
  );
  const src = activeSource?.url ?? "";
  const streamType = activeSource?.type ?? "hls";
  /**
   * Delivery routing — three outcomes, see `sourceDelivery`:
   *
   *  direct  play the URL as-is (zero server cost).
   *  remux   container-only problem. MKV/WebM open in no browser, but many hold
   *          streams this browser decodes natively (AV1, H.264, Opus), so the
   *          server rewraps to fMP4 with `-c copy` — no decode, no encode.
   *          This is what lets a 4K AV1 MKV play at its real 4K, because
   *          nothing is being re-encoded and so nothing is being downscaled.
   *  transcode  the codec itself is undecodable here. Genuine re-encode, still
   *          production-disabled, so these remain visible-but-unselectable.
   */
  const delivery = activeSource ? sourceDelivery(activeSource) : "unavailable";
  const needsRemux = !!activeSource && delivery === "remux";
  /**
   * Remux only. TRANSCODER_ENABLED=0 — an unavailable source must not hop
   * to `/api/transcode` (503). Dock already blocks picking these; if one
   * becomes active, fail closed on the raw URL rather than a dead encoder.
   */
  const serverPath = needsRemux;
  const serverUrl =
    serverPath && tmdbId && activeSource
      ? buildRemuxUrl({
          source: activeSource,
          mediaType: mediaType ?? "movie",
          tmdbId,
          season: tvSeason,
          episode: tvEpisode,
          audio: audioSelectionRef.current,
          startAtSeconds: PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED
            ? remuxStartAtSeconds
            : 0,
        })
      : "";
  const effectiveSrc = serverPath && serverUrl ? serverUrl : src;
  const effectiveStreamType = serverPath && serverUrl ? "hls" : streamType;
  // Play as soon as we have a source URL — never wait for scrape enrichment.
  const hasStream = !!src;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { previewSrc, scoutRef } = useHoverPreview({
    videoRef,
    hoverTime,
    remux: needsRemux,
    poster: artwork || poster,
  });

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<MediaPlayerClass | null>(null);
  const playbackEngineRef = useRef<"hlsjs" | "native_hls" | "native_file" | "dash">(
    "native_file"
  );
  const audiblePlaybackEstablishedRef = useRef(false);
  const renditionFailureCountsRef = useRef<Map<string, number>>(new Map());
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastProgressSave = useRef(0);
  const firstProgressSavedRef = useRef(false);
  /** Fire-once next-episode source preresolve once binge progress crosses 45%. */
  const nextEpPreloadedRef = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  /** Prevent the synthetic click following a touch gesture from firing the
   * video click handler a second time. */
  const suppressVideoClickUntilRef = useRef(0);
  /** A conclusive preview mismatch should refresh server-side caches once,
   * even when a healthy alternate source takes over immediately. */
  const durationRefreshRequestedRef = useRef(false);

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

  /**
   * The loading overlay is intentionally not told which server it is waiting
   * on — an empty name routes LoadingScreen to its generic status rotation
   * ("Finding sources…" / "Connecting…") instead of "Connecting to Zeus…".
   * The resolved name is still published to the store for the Servers panel
   * and the settings dock, which are where it belongs.
   */
  const huntingName = "";
  /**
   * One continuous full-bleed overlay for the whole pre-first-frame journey.
   * Stay up until `everPlayed` — a picked source with buffering=false (manifest
   * parsed, no frame yet) used to drop the card and flash a black video.
   */
  const showHunting = !error && !sourcesError && !everPlayed;
  /** Mid-play remux skip: last frame + spinner. Never the first-load title card. */
  const showSeekSpinner = remuxPacking && everPlayed;
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
  /**
   * Deliberately server-agnostic copy. Which CDN we landed on is internal
   * plumbing — naming it ("Connecting to Zeus…") leaks infrastructure the
   * viewer can neither act on nor care about. The Servers panel still exposes
   * the full roster for anyone who wants to switch by hand.
   */
  /**
   * Narrate the actual stage, with real numbers, instead of a single vague
   * spinner. The viewer should be able to tell "still searching" from "found
   * things, connecting" from "connected, filling the buffer" — those fail in
   * different ways and take very different amounts of time.
   *
   * Deliberately describes the STAGE and the COUNT rather than naming the CDN:
   * "Connecting to Zeus…" is infrastructure trivia the viewer cannot act on
   * (and was removed on purpose), whereas "source 2 of 7" tells them progress
   * is being made and how much runway is left. Server identities remain one tap
   * away in the Servers list.
   */
  const totalSourceCount = orderedSources.length;
  const activeSourceIndex = activeSource
    ? orderedSources.findIndex((s) => s.id === activeSource.id) + 1
    : 0;
  /**
   * Core-ring fill: how full the pre-roll buffer is, 0..1. The bloom's only
   * true progress indicator, so it must come from measured buffer and never
   * from a timer. BLOOM_TARGET_BUFFER_S is the pre-roll depth the ring reads
   * as "full" — matching it to the TV/desktop forward-buffer target would make
   * the ring sit near empty for the whole wait on desktop.
   */
  const bloomBufferFill = (() => {
    const video = videoRef.current;
    if (!video) return 0;
    const ahead = bufferedAheadSeconds(video);
    if (ahead < 0) return 0;
    return Math.min(1, ahead / BLOOM_TARGET_BUFFER_S);
  })();

  const loadingStatus: string | null = remuxPacking
    ? activeSource && sourceMaxHeight(activeSource) >= 2160
      ? "Buffering 4K…"
      : "Buffering…"
    : !hasStream
    ? totalSourceCount > 0
      ? `Found ${totalSourceCount} source${totalSourceCount === 1 ? "" : "s"} — choosing the best…`
      : null // no sources yet: let LoadingScreen run its "Finding sources…" rotation
    : serverPath
      ? needsRemux
        ? activeSource && sourceMaxHeight(activeSource) >= 2160
          ? "Preparing 4K…"
          : "Repackaging for your browser…"
        : "Preparing stream — this can take a few seconds…"
      : levelsPending
        ? activeSourceIndex > 0 && totalSourceCount > 1
          ? `Connecting… (source ${activeSourceIndex} of ${totalSourceCount})`
          : "Connecting…"
        : playingHeight > 0
          ? `Buffering ${formatResolutionLabel(playingHeight)}…`
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
  const setPlayingWidth = usePlayerStore((s) => s.setPlayingWidth);
  const setPlayingBitrate = usePlayerStore((s) => s.setPlayingBitrate);
  const setPlayingFps = usePlayerStore((s) => s.setPlayingFps);
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

  /**
   * Latest-value mirrors for the long-lived callbacks below.
   *
   * The media engines (hls.js/dash.js), the keyboard handler and
   * `failActiveSource` all have to survive re-renders without changing
   * identity — re-creating them would tear down and re-attach a playing
   * engine — so they read the current value out of a ref instead of closing
   * over it.
   *
   * These were assigned during render, which React does not allow: a render
   * can be thrown away or replayed, and a ref written on a discarded render
   * would still be observable afterwards. Writing them in one effect keeps
   * every mirror in a single place and preserves the ordering that matters —
   * this effect is declared before every effect that attaches an engine or a
   * listener, and effects run in declaration order within a commit, so those
   * still see the values from the render they belong to. Nothing reads these
   * during render (only `mediaFaulted` did, and it is state now).
  */
  const activeSourceRef = useRef(activeSource);
  const lastStallFeedbackAtRef = useRef(0);
  /** Stable roster snapshot — failActiveSource must not change identity on enrich. */
  const orderedSourcesRef = useRef(orderedSources);
  const onRetrySourcesRef = useRef(onRetrySources);
  /** While full enrich is still adding servers, never hard-fail the watch shell. */
  const isDiscoveringRef = useRef(false);
  const dockOpenRef = useRef(false);
  const shortcutsOpenRef = useRef(false);
  const durationProvisionalRef = useRef(false);
  const fallbackDurationSRef = useRef(fallbackDurationS);
  useEffect(() => {
    fallbackDurationSRef.current = fallbackDurationS;
    activeSourceRef.current = activeSource;
    orderedSourcesRef.current = orderedSources;
    onRetrySourcesRef.current = onRetrySources;
    isDiscoveringRef.current = Boolean(isDiscoveringSources);
    dockOpenRef.current = dockOpen;
    shortcutsOpenRef.current = shortcutsOpen;
    remuxStartAtRef.current = remuxStartAtSeconds;
    remuxTimelineActiveRef.current =
      PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED && needsRemux;
  });
  const setRemuxStart = useCallback((seconds: number) => {
    const normalized = Math.max(0, Math.floor(seconds));
    remuxStartAtRef.current = normalized;
    setRemuxStartAtSeconds(normalized);
  }, [setRemuxStartAtSeconds]);
  const logicalPlayhead = useCallback((mediaSeconds: number): number => {
    return remuxTimelineActiveRef.current
      ? toLogicalTime(mediaSeconds, remuxStartAtRef.current)
      : mediaSeconds;
  }, []);
  const prepareSourceTimeline = useCallback(
    (source: PlaybackSource, logicalTargetSeconds: number) => {
      const offset =
        PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED &&
        sourceDelivery(source) === "remux" &&
        logicalTargetSeconds > RESUME_SLOW_THRESHOLD_S
          ? normalizeRemuxStart(
              logicalTargetSeconds,
              fallbackDurationSRef.current
            )
          : 0;
      setRemuxStart(offset);
    },
    [setRemuxStart]
  );
  /** hls.js levels with ladder/maxHeight annotation from source metadata. */
  const levelsFromHls = useCallback((hls: Hls): QualityLevel[] => {
    const src = activeSourceRef.current;
    const fallback = src ? sourceMaxHeight(src) : 0;
    const ladder = src?.ladder ?? [];
    return mapHlsLevels(hls, fallback, ladder);
  }, []);
  const tryNextSourceRef = useRef<() => boolean>(() => false);
  const networkRecoveriesRef = useRef(0);
  const lastStallRecoverAtRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * One controller owns source identity and terminal-failure arbitration for
   * every media engine. It prevents a late callback from a destroyed engine
   * from failing whichever source happens to be current now.
   */
  const sourceAttemptControllerRef = useRef(new SourceAttemptController());
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
    on:
      PLAYBACK_TRACK_POLICY_ENABLED &&
      subtitlePreferenceRef.current === "english",
    lang:
      PLAYBACK_TRACK_POLICY_ENABLED &&
      subtitlePreferenceRef.current === "english"
        ? "en"
        : null,
  });
  const userSelectedSubtitleRef = useRef(false);
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

  /**
   * Ask mediaCapabilities whether 4K HEVC/AV1 decode actually works here. The
   * synchronous string matrix already gave ranking an answer; this only ever
   * upgrades it, and only for browsers that expose the API. Fire-and-forget by
   * design — playback must never wait on a capability query.
   */
  useEffect(() => {
    void warmDecodeCapabilities();
  }, []);

  const markEverPlayed = useCallback(() => {
    playbackSession.dispatch({ type: "first_frame" });
    const source = activeSourceRef.current;
    const video = videoRef.current;
    const attempt = sourceAttemptControllerRef.current.currentToken();
    const timeToFirstFrameMs =
      source && attempt?.sourceId === source.id
        ? sourceAttemptControllerRef.current.claimFirstFrame(attempt)
        : null;
    if (source && attempt && timeToFirstFrameMs != null) {
      emitPlayerFeedback({
        event: "first_frame",
        sourceId: source.id,
        provider: source.provider,
        attemptId: attempt.attemptId,
        timeToFirstFrameMs,
        decodedHeight:
          video && video.videoHeight > 0
            ? decodedQualityHeight(video.videoWidth, video.videoHeight)
            : undefined,
        selectedHeight: usePlayerStore.getState().playingHeight || undefined,
        audioCodec: source.audioCodec,
        audioLanguage:
          usePlayerStore.getState().audioTracks.find(
            (track) => track.id === usePlayerStore.getState().activeAudioId
          )?.lang,
        engine: playbackEngineRef.current,
      });
    }
    setRemuxPacking(false);
    if (everPlayedRef.current) return;
    everPlayedRef.current = true;
    setEverPlayed(true);
    setIsSwitchingServer(false);
  }, [playbackSession]);

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
      if (remuxSeekTimerRef.current) clearTimeout(remuxSeekTimerRef.current);
      remuxSeekAbortRef.current?.abort();
    };
  }, []);

  /**
   * Episode/title identity — reset session flags so next title never inherits
   * resume/source state. TMDB id only: the first paint often has title
   * "Untitled" (or a placeholder) which then flips to the real name and
   * would wipe resume + the sticky source if `title` were in this key.
   */
  const mediaKey = `${mediaType ?? "movie"}:${tmdbId ?? tvId ?? "0"}:${tvSeason ?? ""}:${tvEpisode ?? ""}`;

  /**
   * Session reset on title/episode change. This cannot become a render-phase
   * adjustment: most of what it clears lives OUTSIDE React — a dozen refs and
   * several player-store setters — and neither may be touched during render.
   * It is a synchronization with external systems, which is what effects are
   * for; the rule cannot distinguish those setters from useState.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    invalidateSourceAttempt();
    failedSourceIdsRef.current.clear();
    durationRefreshRequestedRef.current = false;
    setFailedSourceIds([]);
    userSelectedSourceRef.current = false;
    userSelectedQualityRef.current = false;
    autoUpgradedRef.current = false;
    everPlayedRef.current = false;
    firstProgressSavedRef.current = false;
    userPausedRef.current = false;
    audiblePlaybackEstablishedRef.current = false;
    initialTimeAppliedRef.current = false;
    userSelectedSubtitleRef.current = false;
    userSelectedAudioRef.current = false;
    manualAudioTrackRef.current = null;
    audioSelectionRef.current = {
      preference: profileAudioPreference ?? getAudioPreference(),
      originalLanguage,
      preferredLanguage: profileAudioLanguage ?? getPreferredAudioLanguage(),
    };
    const defaultEnglishSubtitles =
      PLAYBACK_TRACK_POLICY_ENABLED &&
      subtitlePreferenceRef.current === "english";
    subtitleIntentRef.current = {
      on: defaultEnglishSubtitles,
      lang: defaultEnglishSubtitles ? "en" : null,
    };
    seenSourceIdsRef.current = new Set();
    // Always start the new title/episode at 0 unless continue-watching seeds initialTime.
    resumeAtRef.current = 0;
    remuxSeekGenerationRef.current += 1;
    if (remuxSeekTimerRef.current) {
      clearTimeout(remuxSeekTimerRef.current);
      remuxSeekTimerRef.current = null;
    }
    remuxSeekAbortRef.current?.abort();
    remuxSeekAbortRef.current = null;
    remuxRollbackRef.current = null;
    pendingRemuxSeekTargetRef.current = null;
    setRemuxStart(
      PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED
        ? normalizeRemuxStart(initialTime ?? 0, fallbackDurationS)
        : 0
    );
    setCurrentTime(0);
    setEverPlayed(false);
    setMediaFaulted(false);
    durationProvisionalRef.current = false;
    setDurationProvisional(false);
    setIsSwitchingServer(false);
    setRemuxPacking(false);
    setActiveSource(null);
    lastStallFeedbackAtRef.current = 0;
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
    // Deps: title/episode identity only — everything else here is a reset.
  }, [mediaKey, setCurrentTime, setError, invalidateSourceAttempt, setRemuxStart]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
      // Teardown, not derivation: it invalidates the in-flight attempt token
      // (a ref) and pushes the result to the player store in the same pass, so
      // it has to run as an effect. Guarded so an already-empty roster is a
      // no-op rather than a repeated store write.
      invalidateSourceAttempt();
      if (activeSource) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveSource(null);
      }
       
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
        const t = logicalPlayhead(videoRef.current?.currentTime ?? 0);
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
    let remaining = orderedSources.filter((s) => !failedSourceIdsRef.current.has(s.id));
    if (!remaining.length && isDiscoveringRef.current) {
      remaining = orderedSources;
    }
    const pool = remaining.length ? remaining : orderedSources;
    const selection = selectActiveSource({
      roster: pool,
      active: activeSource,
      failedIds: failedSourceIdsRef.current,
      userPicked: userSelectedSourceRef.current,
      everPlayed: everPlayedRef.current,
      autoUpgraded: autoUpgradedRef.current,
      fourKStartup: PLAYBACK_FAST_4K_ENABLED
        ? fourKStartupRef.current
        : "maximum",
      preferredProvider: preferred,
      preferredHeight,
      remuxAvailable: remuxAvailableRef.current,
    });
    const best = selection.next;

    if (selection.replace && best && best.id !== activeSource?.id) {
      if (selection.reason === "roster_upgrade" || selection.reason === "language_rescue") {
        autoUpgradedRef.current = true;
      }
      const t = logicalPlayhead(videoRef.current?.currentTime ?? 0);
      if (t > RESUME_CAPTURE_MIN_S) resumeAtRef.current = t;
      if (selection.reason === "start" || selection.reason === "failover") {
        prepareSourceTimeline(best, t);
      }
      initialTimeAppliedRef.current = false;
      setError(null);
      invalidateSourceAttempt();
      setActiveSource(best);
      setBuffering(true);
      if (!stillValid) {
        failedSourceIdsRef.current.clear();
        setFailedSourceIds([]);
      }
      return;
    }

    if ((!stillValid || (activeFailed && !userSelectedSourceRef.current)) && !stillValid) {
      failedSourceIdsRef.current.clear();
      setFailedSourceIds([]);
    }
  }, [
    orderedSources,
    activeSource,
    setBuffering,
    setError,
    invalidateSourceAttempt,
    markEverPlayed,
    logicalPlayhead,
    prepareSourceTimeline,
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
    // Zustand write, not React state. React's own guidance says an effect is
    // for "update external systems with the latest state from React", which is
    // exactly this — the lint rule just cannot tell a store setter apart from
    // a useState setter, and there is no cascading render to avoid here.
     
    if (!hasStream) setBuffering(false);
  }, [hasStream, setBuffering]);

  useEffect(() => {
    if (!hasStream || swipeHintShownRef.current) return;
    if (typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches) return;
    swipeHintShownRef.current = true;
    // A once-per-session hint gated on a touch pointer. It cannot be decided
    // during render without breaking hydration — the server has no matchMedia,
    // so a render-phase answer would differ from the client's. One extra render
    // on first play, exactly once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setServerDisplayName(getServerDisplayName(activeSource.provider, activeSource.label));
    }
  }, [activeSource, setServerDisplayName]);

  const syncHlsTracks = useCallback(
    (hls: Hls) => {
      const audio = mapAudioTracks(hls);
      const subs = mapSubtitleTracks(hls);
      setAudioTracks(audio);
      setSubtitleTracks(subs);

      if (audio.length > 0) {
        const manual = manualAudioTrackRef.current;
        const audioId =
          manual !== null &&
          manual.sourceId === activeSourceRef.current?.id &&
          hlsHasTrackId(hls.audioTracks, manual.trackId)
            ? manual.trackId
            : pickPreferredAudioId(hls, audioSelectionRef.current);
        hls.audioTrack = audioId;
        setActiveAudioId(audioId);
      }

      // Re-apply the user's persisted caption intent — NOT the store's
      // subtitlesOn/activeSubtitleId, which resetStream() just wiped for this
      // new source. Reading the store here would always see "off" right after
      // a server switch, which was the "captions silently turn off" bug.
      if (subs.length > 0 && subtitleIntentRef.current.on) {
        const wantLang = subtitleIntentRef.current.lang;
        const matched = pickPreferredSubtitle(subs, wantLang);
        if (matched) {
          hls.subtitleTrack = matched.id;
          hls.subtitleDisplay = true;
          setActiveSubtitleId(matched.id);
          setSubtitlesOn(true);
        }
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
        const manual = manualAudioTrackRef.current;
        const match =
          (manual !== null && manual.sourceId === activeSourceRef.current?.id
            ? audio.find((track) => track.id === manual.trackId)
            : null) ??
          selectAudioTrack(audio, audioSelectionRef.current) ??
          audio[0];
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
        matchedId = pickPreferredSubtitle(subs, wantLang)?.id ?? null;
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

  /** Apply a profile that arrived after the player shell mounted. */
  useEffect(() => {
    if (!userSelectedSubtitleRef.current) {
      const english =
        PLAYBACK_TRACK_POLICY_ENABLED &&
        subtitlePreferenceRef.current === "english";
      subtitleIntentRef.current = {
        on: english,
        lang: english ? "en" : null,
      };
    }
    const hls = hlsRef.current;
    const video = videoRef.current;
    if (hls) syncHlsTracks(hls);
    else if (video) syncNativeTracks(video);
  }, [
    originalLanguage,
    profileAudioLanguage,
    profileAudioPreference,
    profileSubtitlePreference,
    syncHlsTracks,
    syncNativeTracks,
  ]);

  const markSourceFailed = useCallback((sourceId: string) => {
    if (failedSourceIdsRef.current.has(sourceId)) return;
    failedSourceIdsRef.current.add(sourceId);
    setFailedSourceIds((prev) => [...prev, sourceId]);
  }, []);

  /**
   * Status toasts. Declared before any callback that lists them in a React
   * dep array — a later declaration threw "Cannot access 'rt' before
   * initialization" on every watch mount (TDZ when useCallback read deps).
   */
  const showFailoverNotice = useCallback((_failed: PlaybackSource, _next: PlaybackSource) => {
    setFailoverNotice("Switching servers…");
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

  const handleSourceChange = useCallback(
    (
      source: PlaybackSource,
      opts?: { userPick?: boolean; remuxStartAtSeconds?: number }
    ) => {
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
        setServerDisplayName(getServerDisplayName(resolved.provider, resolved.label));
        return;
      }
      remuxSeekGenerationRef.current += 1;
      if (remuxSeekTimerRef.current) {
        clearTimeout(remuxSeekTimerRef.current);
        remuxSeekTimerRef.current = null;
      }
      remuxSeekAbortRef.current?.abort();
      remuxSeekAbortRef.current = null;
      pendingRemuxSeekTargetRef.current = null;
      remuxRollbackRef.current = null;
      // Capture live position when available; never wipe an existing resume target
      // with t≈0 (common when the element was already torn down mid-failover).
      const t = logicalPlayhead(video?.currentTime ?? 0);
      if (t > RESUME_CAPTURE_MIN_S) {
        resumeAtRef.current = t;
        // Keep store clock on the real playhead so chrome does not flash 0:00.
        setCurrentTime(t);
      } else if (resumeAtRef.current > RESUME_CAPTURE_MIN_S) {
        setCurrentTime(resumeAtRef.current);
      }
      // Allow a fresh seek apply on the new stream (resume target kept above).
      initialTimeAppliedRef.current = false;
      if (
        PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED &&
        sourceDelivery(resolved) === "remux" &&
        opts?.remuxStartAtSeconds != null
      ) {
        setRemuxStart(opts.remuxStartAtSeconds);
      } else {
        prepareSourceTimeline(
          resolved,
          t > RESUME_CAPTURE_MIN_S ? t : resumeAtRef.current
        );
      }
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
        failedSourceIdsRef.current.delete(resolved.id);
        setFailedSourceIds((prev) => prev.filter((id) => id !== resolved.id));
        setSourceReloadGeneration((generation) => generation + 1);
      }
      // Only persist preference on explicit user pick — auto failover must not stick Luna forever.
      if (opts?.userPick) {
        setPreferredProvider(preferenceKey(resolved));
      }
      setServerDisplayName(getServerDisplayName(resolved.provider, resolved.label));
    },
    [
      setError,
      setBuffering,
      setServerDisplayName,
      setCurrentTime,
      invalidateSourceAttempt,
      logicalPlayhead,
      prepareSourceTimeline,
      setRemuxStart,
    ]
  );

  /** Dock / settings server pick — locks out enrich auto-upgrade for this session. */
  const handleUserSourceChange = useCallback(
    (source: PlaybackSource) => {
      if (!isSourcePlayableHere(source)) return;
      userSelectedSourceRef.current = true;
      const picked =
        orderedSourcesRef.current.find((row) => row.id === source.id) ?? source;
      const resolved =
        findDirectDebridAlternative(picked, orderedSourcesRef.current) ?? picked;
      const playing = everPlayedRef.current;
      const video = videoRef.current;
      const playhead = logicalPlayhead(video?.currentTime ?? 0);
      if (
        playing &&
        tmdbId &&
        sourceDelivery(resolved) === "remux" &&
        PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED
      ) {
        const startAtSeconds = normalizeRemuxStart(
          playhead > RESUME_CAPTURE_MIN_S ? playhead : resumeAtRef.current,
          fallbackDurationSRef.current
        );
        if (video) freezeLastVideoFrame(video);
        setIsSwitchingServer(true);
        setBuffering(true);
        remuxSeekAbortRef.current?.abort();
        const controller = new AbortController();
        remuxSeekAbortRef.current = controller;
        const prewarmUrl = buildRemuxUrl({
          source: resolved,
          mediaType: mediaType ?? "movie",
          tmdbId,
          season: tvSeason,
          episode: tvEpisode,
          audio: audioSelectionRef.current,
          prewarm: true,
          startAtSeconds,
        });
        void prewarmRemuxPosition(prewarmUrl, { signal: controller.signal })
          .then(() => {
            if (controller.signal.aborted) return;
            handleSourceChange(resolved, {
              userPick: true,
              remuxStartAtSeconds: startAtSeconds,
            });
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            setIsSwitchingServer(false);
            setRemuxPacking(false);
            setBuffering(false);
            showStatusNotice("Couldn’t open that server", 2_500);
          });
        return;
      }
      handleSourceChange(resolved, { userPick: true });
    },
    [
      handleSourceChange,
      logicalPlayhead,
      mediaType,
      setBuffering,
      showStatusNotice,
      tmdbId,
      tvEpisode,
      tvSeason,
    ]
  );

  const recordDetectedHeight = useCallback((sourceId: string, height: number) => {
    if (!sourceId || height <= 0) return;
    setDetectedHeights((prev) => {
      if (prev[sourceId] === height) return prev;
      return { ...prev, [sourceId]: height };
    });
  }, []);

  const tryNextSource = useCallback(() => {
    if (activeSource) markSourceFailed(activeSource.id);
    const available = orderedSources.filter((s) => !failedSourceIdsRef.current.has(s.id));
    const next = decidePlayback(available, {
      preferredProvider: getPreferredProvider(),
      preferredHeight: qualityTargetRef.current,
      fourKStartup: fourKStartupRef.current,
    }).immediate;
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

    const pick = decidePlayback(orderedSources, {
      preferredProvider: getPreferredProvider(),
      preferredHeight: qualityTargetRef.current,
      fourKStartup: fourKStartupRef.current,
    }).immediate;
    if (!pick || pick.id === activeSource.id) return;
    if (
      sourceDelivery(pick) === "remux" &&
      sourceDelivery(activeSource) === "direct" &&
      fourKStartupRef.current !== "maximum"
    ) {
      return;
    }

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
    if (!everPlayed || !orderedSources.length) return;
    const candidates = orderedSources
      .filter(
        (s) =>
          s.id !== activeSource?.id &&
          isSameOriginPlaybackUrl(s.url) &&
          !isPoisonStreamUrl(s.url) &&
          s.probe == null &&
          probedHealth[s.id] == null &&
          !probeInFlightRef.current.has(s.id)
      )
      .slice(0, BG_HEALTH_PROBE_MAX_PER_PASS);
    if (!candidates.length) return;

    const abort = new AbortController();
    const byUrl = new Map(candidates.map((c) => [c.url, c.id] as const));
    for (const c of candidates) probeInFlightRef.current.add(c.id);

    runBoundedHealthProbes(
      candidates.map((c) => c.url),
      BG_HEALTH_PROBE_CONCURRENCY,
      abort.signal,
      probeSourceReachabilityCached,
      (url, probe) => {
        const id = byUrl.get(url);
        if (!id) return;
        setProbedHealth((prev) => (prev[id] ? prev : { ...prev, [id]: probe }));
      }
    ).finally(() => {
      for (const c of candidates) probeInFlightRef.current.delete(c.id);
    });

    return () => {
      abort.abort();
    };
    // Deliberately excludes `probedHealth` — it only gates which candidates
    // are queued (read fresh via closure whenever this re-runs), never a
    // trigger for re-running itself, or every resolved probe would re-arm
    // this effect and cycle indefinitely.
     
  }, [orderedSources, activeSource?.id, everPlayed]);

  // Assigned in an effect rather than during render: `failActiveSource` only
  // ever reads this from timers, engine callbacks and event handlers, all of
  // which run after effects have flushed, so deferring the write costs nothing
  // and keeps render side-effect-free.
  useEffect(() => {
    tryNextSourceRef.current = tryNextSource;
  }, [tryNextSource]);

  const handleRetryFull = useCallback(() => {
    failedSourceIdsRef.current.clear();
    setFailedSourceIds([]);
    // Same source id may come back from the re-fetch with a renewed URL
    // (expired token, transient scrape miss) — see pendingUrlRefreshRef.
    pendingUrlRefreshRef.current = true;
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
      const rollback = remuxRollbackRef.current;
      if (
        PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED &&
        rollback?.sourceId === source.id &&
        remuxStartAtRef.current !== rollback.startAtSeconds
      ) {
        remuxRollbackRef.current = null;
        pendingRemuxSeekTargetRef.current = null;
        resumeAtRef.current = rollback.logicalTime;
        initialTimeAppliedRef.current = false;
        setRemuxStart(rollback.startAtSeconds);
        setCurrentTime(rollback.logicalTime);
        setError(null);
        setBuffering(true);
        setIsSwitchingServer(true);
        showStatusNotice("Seek failed — returning to playback…", 2_500);
        emitPlayerFeedback({
          event: "stall",
          sourceId: source.id,
          provider: source.provider,
          attemptId: attempt.attemptId,
          engine: playbackEngineRef.current,
          reason,
        });
        return true;
      }
      emitPlayerFeedback({
        event: "handoff_failed",
        sourceId: source.id,
        provider: source.provider,
        attemptId: attempt.attemptId,
        selectedHeight: usePlayerStore.getState().playingHeight || undefined,
        audioCodec: source.audioCodec,
        engine: playbackEngineRef.current,
        reason,
      });
      markSourceFailed(attempt.sourceId);
      // Fatal media/network failure → next source now. Never wait for enrich.
      if (tryNextSourceRef.current()) return true;
      // Only hold for more sources if we have literally nothing left to try
      // AND enrich is still open — otherwise surface hard error immediately.
      // Read roster via ref so this callback stays stable across enrich polls.
      const roster = orderedSourcesRef.current;
      const remaining = roster.filter(
        (s) => !failedSourceIdsRef.current.has(s.id) && s.id !== source.id
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
      setCurrentTime,
      setRemuxStart,
      showStatusNotice,
      setLevelsPending,
      setIsSwitchingServer,
    ]
  );

  const rejectImplausiblyShortDuration = useCallback(
    (observedDurationS: number): boolean => {
      // A live remux reports only the amount produced so far. Its duration is
      // intentionally provisional and must never be mistaken for a preview.
      if (needsRemux || durationProvisionalRef.current) return false;
      const expectedDurationS = fallbackDurationSRef.current;
      const assessment = assessMediaDuration(
        observedDurationS,
        expectedDurationS,
        mediaType ?? "movie"
      );
      if (assessment.plausible) return false;
      const attempt = sourceAttemptControllerRef.current.currentToken();
      if (!attempt) return false;
      const failedOver = failActiveSource("implausibly_short_duration", attempt);
      if (failedOver && !durationRefreshRequestedRef.current) {
        durationRefreshRequestedRef.current = true;
        // The next source can begin immediately; refresh stale scraper/debrid
        // rows in parallel so a future visit does not start on this preview.
        queueMicrotask(() => onRetrySourcesRef.current?.());
      }
      return failedOver;
    },
    [failActiveSource, mediaType, needsRemux]
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
  // Wall duration is adaptive (R8): cold multi-source ~20s; resume / sole source ~28s;
  // remux/transcode floors at 52s so the packer is not killed mid-job.
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
    const remuxOrTranscode =
      (activeSource != null && sourceDelivery(activeSource) === "remux") ||
      effectiveSrc.includes("/api/transcode");
    const wallMs = firstFrameWallMs({ resumeAt, remainingSources, remuxOrTranscode });
    const timer = window.setTimeout(() => {
      if (everPlayedRef.current) return;
      if (usePlayerStore.getState().error) return;
      failActiveSource("first_frame_timeout");
    }, wallMs);
    return () => window.clearTimeout(timer);
    // orderedSources read at arm time only — do not re-arm when enrich appends.
    // Deps: one stable wall per active source; enrich must not re-arm it.
  }, [everPlayed, hasStream, activeSource?.id, initialTime, failActiveSource]);

  /**
   * Engine attach. This effect IS the external system: it creates and destroys
   * hls.js/dash.js, assigns `video.src`, binds media listeners and tears them
   * all down again. Its setState calls report the outcome of that imperative
   * work into the player store, and the outcome is only knowable after the
   * attempt — there is nothing here that could be derived during render.
   * Suppressed for the whole effect rather than line by line, since every
   * occurrence has the same reason.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasStream) {
      setBuffering(false);
      return;
    }

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

    if (everPlayedRef.current) {
      freezeLastVideoFrame(video);
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
        v.currentTime = remuxTimelineActiveRef.current
          ? toMediaTime(target, remuxStartAtRef.current)
          : target;
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

    const {
      useDash,
      useHls,
      isTranscoded,
      isHomeHlsProxy,
      isWorkerProxy,
    } = classifyPlaybackUrl(effectiveSrc, effectiveStreamType);
    playbackSession.dispatch({ type: "attach" });

    const sourceAttempt = sourceAttemptControllerRef.current.begin(
      activeSourceRef.current?.id ?? effectiveSrc
    );
    renditionFailureCountsRef.current.clear();
    // A new attempt starts unfaulted — otherwise a failover onto a working
    // source would keep showing the blocking error left by the one before it.
    setMediaFaulted(false);
    // Likewise provisional-duration: it belongs to the stream being replaced.
    // A progressive source has a real duration from the start, and only an
    // HLS LEVEL_LOADED can set this again.
    durationProvisionalRef.current = false;
    setDurationProvisional(false);
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
      setMediaFaulted(true);
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
      // After resume seek lands, start a fresh cold zero-progress window.
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
      recoverHlsPlayback(hls, video, qualityTargetRef.current);
    };

    if (useDash) {
      playbackEngineRef.current = "dash";
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
            setPlayingHeight(
              pictureHeightFromElement(
                video,
                lvl ? effectiveLevelHeight(lvl) : 0
              )
            );
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
              const floorKbps = findFloorBitrateKbps(levelList, HLS_MIN_HEIGHT);
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
              attemptAutoplay(
                video,
                onAutoplayBlocked,
                onMutedAutoplayFallback,
                !isTvLikeDevice() && !audiblePlaybackEstablishedRef.current
              );
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
      const preferNative = preferNativeHls(video, activeSourceRef.current);
      if (Hls.isSupported() && !preferNative) {
        playbackEngineRef.current = "hlsjs";
        const startPos =
          resumeAtRef.current > 1
            ? remuxTimelineActiveRef.current
              ? toMediaTime(resumeAtRef.current, remuxStartAtRef.current)
              : resumeAtRef.current
            : -1;
        // Living-room TV browsers get a quarter of the desktop memory
        // envelope — see src/lib/playback/device-profile.ts. Desktop values
        // are unchanged; only a positive TV match differs.
        const bufferProfile = activeBufferProfile();
        const hls = new Hls({
          enableWorker: hlsWorkerSupportedHere(),
          workerPath: HLS_WORKER_PATH,
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
          abrEwmaDefaultEstimate: bufferProfile.abrInitialEstimateBps,
          abrEwmaFastVoD: 3,
          abrEwmaSlowVoD: 9,
          abrMaxWithRealBitrate: true,
          // Never cap by CSS box size — that was the 1080 label / 720 reality bug.
          capLevelToPlayerSize: false,
          maxBufferLength: bufferProfile.maxBufferLengthS,
          maxMaxBufferLength: bufferProfile.maxMaxBufferLengthS,
          maxBufferSize: bufferProfile.maxBufferSizeBytes,
          maxBufferHole: 0.8,
          backBufferLength: bufferProfile.backBufferLengthS,
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
          // Give hls.js the same first-request hint as the explicit track
          // selector below; the explicit selector remains authoritative.
          audioPreference: {
            lang:
              (audioSelectionRef.current.preference === "original"
                ? normalizeTrackLanguage(
                    audioSelectionRef.current.originalLanguage
                  )
                : audioSelectionRef.current.preference === "english"
                  ? "en"
                  : normalizeTrackLanguage(
                      audioSelectionRef.current.preferredLanguage
                    )) || "en",
          },
          xhrSetup: (xhr) => {
            // Same-origin /api/hls needs session cookies (NextAuth).
            if (isHomeHlsProxy) xhr.withCredentials = true;
          },
        });
        /**
         * Pin the opening rung BEFORE anything is fetched.
         *
         * MANIFEST_PARSED (below) already applies the product rule, but it is
         * too late: `startFragPrefetch` deliberately requests the first
         * fragment while the manifest is still settling, so that fragment came
         * from whatever level hls.js chose for itself — and with
         * `startLevel: -1` that is the master's first listed rung, which is
         * usually its lowest. Measured on Squid Game S1E1: 854x480 at first
         * frame, 1920x1080 twenty seconds later, once ABR had caught up.
         *
         * MANIFEST_LOADED is the earliest event carrying the ladder and fires
         * before any fragment request, so the same rule lands in time here.
         * Only `startLevel` is touched — `loadLevel` and everything after the
         * first fragment stay with MANIFEST_PARSED, whose level controller is
         * fully initialised by then.
         *
         * Registered BEFORE `loadSource`, which is load-bearing: loadSource
         * starts the manifest request immediately, and a fast manifest —
         * anything already warm behind the local proxy — resolves before a
         * listener attached further down would exist. That is exactly what
         * happened on the first attempt at this fix: Squid Game (slow
         * manifest) opened at 1080p while Dark, Breaking Bad and RRR still
         * opened at 480p/720p.
         */
        hls.on(Hls.Events.MANIFEST_LOADED, (_evt, data) => {
          try {
            const parsed = (data.levels ?? []).map((level, index) => ({
              index,
              height: level.height ?? 0,
              width: level.width,
              bitrate: level.bitrate,
            }));
            const startIdx = pickStartLevelIndex(parsed, qualityTargetRef.current);
            if (startIdx >= 0) hls.startLevel = startIdx;
          } catch {
            /* leave hls.js to its own choice rather than fail the attach */
          }
        });

        hlsRef.current = hls;
        hls.loadSource(effectiveSrc);
        hls.attachMedia(video);

        // Stuck at 0:00 watchdog — MANIFEST_PARSED alone is not success (Aether PNG segments).
        // Mid-title resume uses a longer window so slow seeks are not failed over early.
        armZeroProgressWatchdog(zeroProgressDelayForResume());
        onTimeProgress = () => {
          // Progress past cold start (or past resume target) means the source is alive.
          const t = logicalPlayhead(video.currentTime ?? 0);
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
                undefined,
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
          // Apply profile/manual audio and subtitle policy as soon as media
          // groups exist. syncHlsTracks pins a concrete audio id immediately,
          // avoiding a DEFAULT-language race on multi-audio masters.
          syncHlsTracks(hls);
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
            if (seedLevel) {
              setPlayingHeight(
                pictureHeightFromElement(video, effectiveLevelHeight(seedLevel))
              );
            }
          }
          const savedSpeed = getSavedPlaybackSpeed();
          if (savedSpeed !== 1) video.playbackRate = savedSpeed;
          applyResumeSeekAndRearm(video);
          if (!userPausedRef.current) {
            attemptAutoplay(
              video,
              onAutoplayBlocked,
              onMutedAutoplayFallback,
              !isTvLikeDevice() && !audiblePlaybackEstablishedRef.current
            );
          }
        });

        /**
         * Apply a floor-promotion result. In Auto mode, re-release currentLevel
         * back to -1 right after the nudge instead of leaving it pinned —
         * otherwise every promotion silently re-disabled ABR (task 3), which
         * would freeze Auto exactly at 1080 after its first dip instead of
         * continuing to adapt/climb.
         */
        const applyPromotionResult = (promoted: number | null) => {
          if (promoted == null || promoted < 0) return;
          const wasAuto = usePlayerStore.getState().quality === -1;
          if (wasAuto) {
            hls.currentLevel = -1;
            hls.nextLevel = -1;
            setQuality(-1);
          } else {
            setQuality(promoted);
          }
        };

        hls.on(Hls.Events.LEVELS_UPDATED, refreshHlsLevels);
        hls.on(Hls.Events.LEVEL_LOADED, refreshHlsLevels);
        /**
         * `details.live` means "this playlist carries no EXT-X-ENDLIST yet",
         * which is only evidence of a GROWING duration for output we produce
         * ourselves. Plenty of embed playlists omit ENDLIST while still
         * reporting a correct, fixed duration, and treating those as
         * provisional would suppress resume progress and the end-of-episode
         * card for most of the roster. So the remux flag is required too: we
         * know that stream is being written segment by segment because we are
         * the ones writing it.
         */
        hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
          const provisional = needsRemux && Boolean(data.details?.live);
          durationProvisionalRef.current = provisional;
          setDurationProvisional(provisional);
          if (remuxTimelineActiveRef.current) {
            setDuration(
              logicalDuration(
                data.details?.totalduration ?? video.duration,
                remuxStartAtRef.current,
                fallbackDurationSRef.current,
                provisional
              )
            );
          }
          if (!provisional) {
            rejectImplausiblyShortDuration(data.details?.totalduration ?? 0);
          }
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          const levelList = levelsFromHls(hls);
          if (videoRef.current && levelList.length) {
            applyPromotionResult(
              maybePromoteHlsQuality(
                hls,
                levelList,
                videoRef.current,
                undefined,
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
          const manual = manualAudioTrackRef.current;
          const audioId =
            manual !== null &&
            manual.sourceId === activeSourceRef.current?.id &&
            hlsHasTrackId(hls.audioTracks, manual.trackId)
              ? manual.trackId
              : pickPreferredAudioId(hls, audioSelectionRef.current);
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
          const manual = manualAudioTrackRef.current;
          const audioId =
            manual !== null &&
            manual.sourceId === activeSourceRef.current?.id &&
            hlsHasTrackId(hls.audioTracks, manual.trackId)
              ? manual.trackId
              : pickPreferredAudioId(hls, audioSelectionRef.current);
          if (hls.audioTrack !== audioId) hls.audioTrack = audioId;
          setActiveAudioId(typeof hls.audioTrack === "number" ? hls.audioTrack : audioId);
        };
        hls.on(Hls.Events.LEVEL_LOADED, refreshAudioLater);
        hls.on(Hls.Events.LEVEL_SWITCHED, refreshAudioLater);

        /**
         * Absolute ABR floor guard, part 1 (pre-emptive): fires BEFORE the
         * switch takes effect. If ABR (or any other path) is about to switch
         * to a sub-1080 level while a >=1080 rung exists on this ladder,
         * cancel the switch immediately by re-pointing nextLevel/loadLevel at
         * the floor rung — so no low-quality fragment is even requested.
         * Re-assigning `nextLevel` here fires a fresh LEVEL_SWITCHING for the
         * floor level, whose own height already satisfies the guard, so this
         * terminates in one hop (no loop).
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
              hls.nextLevel = floorIdx;
              hls.loadLevel = floorIdx;
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
          setPlayingHeight(pictureHeightFromElement(videoRef.current, h));
          setPlayingWidth(
            videoRef.current?.videoWidth || level?.width || 0
          );
          setPlayingBitrate(level?.bitrate ?? 0);
          setPlayingFps(level?.frameRate ?? 0);
          if (h > 0 && h < HLS_MIN_HEIGHT * 0.95 && videoRef.current) {
            applyPromotionResult(
              maybePromoteHlsQuality(
                hls,
                list,
                videoRef.current,
                undefined,
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
          const subId = pickPreferredSubtitle(subs, wantLang)?.id;
          if (subId == null) return;
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
          const levelList = levelsFromHls(hls);
          const levelIndex =
            typeof data.frag?.level === "number" && data.frag.level >= 0
              ? data.frag.level
              : hls.currentLevel >= 0
                ? hls.currentLevel
                : hls.loadLevel;
          const level = levelList.find((candidate) => candidate.index === levelIndex);
          const selectedHeight = level ? effectiveLevelHeight(level) : undefined;
          const source = activeSourceRef.current;
          const detail = String(data.details ?? data.type ?? "hls_error");

          if (
            source &&
            sourceDelivery(source) === "remux" &&
            REMUX_BUSY_HTTP_CODES.has(httpCode)
          ) {
            failActiveSource("remux_unavailable", sourceAttempt);
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
            // errors — they never increment a failover strike. Keep
            // buffering at the 1080 floor indefinitely (owner's absolute
            // policy) instead of downshifting or failing the source over.
            if (
              data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
            ) {
              if (source) {
                emitPlayerFeedback({
                  event: "stall",
                  sourceId: source.id,
                  provider: source.provider,
                  selectedHeight,
                  audioCodec: source.audioCodec,
                  audioLanguage:
                    usePlayerStore.getState().audioTracks.find(
                      (track) => track.id === usePlayerStore.getState().activeAudioId
                    )?.lang,
                  engine: playbackEngineRef.current,
                  errorDetail: detail,
                });
                if (
                  data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT &&
                  everPlayedRef.current
                ) {
                  const count =
                    (fragTimeoutCountsRef.current.get(source.id) ?? 0) + 1;
                  fragTimeoutCountsRef.current.set(source.id, count);
                  if (count >= FRAG_TIMEOUT_FAILOVER_COUNT) {
                    failActiveSource("frag_load_timeout_storm", sourceAttempt);
                    return;
                  }
                }
              }

              // A few providers expose a damaged 480p rendition while their
              // 720p/1080p segments are healthy. Two independent failures on
              // that low rung are enough evidence to move up one rung instead
              // of repeatedly retrying the same broken files.
              if (selectedHeight && selectedHeight <= 540) {
                const key = `${source?.id ?? "unknown"}:${levelIndex}:${selectedHeight}`;
                const failures =
                  (renditionFailureCountsRef.current.get(key) ?? 0) + 1;
                renditionFailureCountsRef.current.set(key, failures);
                if (failures >= 2) {
                  const next = levelList
                    .filter(
                      (candidate) => effectiveLevelHeight(candidate) > selectedHeight
                    )
                    .sort(
                      (a, b) =>
                        effectiveLevelHeight(a) - effectiveLevelHeight(b)
                    )[0];
                  const target = next
                    ? normalizePlayerQualityHeight(effectiveLevelHeight(next))
                    : null;
                  if (next && target) {
                    hls.nextLevel = next.index;
                    hls.loadLevel = next.index;
                    qualityTargetRef.current = target;
                    setQualityTarget(target);
                    setQuality(next.index);
                    renditionFailureCountsRef.current.delete(key);
                    showStatusNotice(
                      `${selectedHeight}p stream unstable — using ${target}p`,
                      4_000
                    );
                  }
                }
              }
              recoverHlsStall(hls);
            }
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (source) {
              emitPlayerFeedback({
                event: "decode_error",
                sourceId: source.id,
                provider: source.provider,
                selectedHeight,
                audioCodec: source.audioCodec,
                audioLanguage:
                  usePlayerStore.getState().audioTracks.find(
                    (track) => track.id === usePlayerStore.getState().activeAudioId
                  )?.lang,
                engine: playbackEngineRef.current,
                errorDetail: detail,
              });
            }
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
          if (isSessionExpiredError(data) && onRetrySourcesRef.current) {
            failedSourceIdsRef.current.clear();
            setFailedSourceIds([]);
            // Re-fetch will hand back this same source id with a renewed URL —
            // without arming this, the reconciliation effect refuses to touch
            // `activeSource` post-first-play and the player keeps silently
            // reloading the now-dead (410) URL forever. See pendingUrlRefreshRef.
            pendingUrlRefreshRef.current = true;
            setBuffering(true);
            if (everPlayedRef.current) setIsSwitchingServer(true);
            onRetrySourcesRef.current();
            return;
          }
          failActiveSource("hls_fatal_error", sourceAttempt);
        });
      } else if (
        preferNative ||
        Boolean(video.canPlayType("application/vnd.apple.mpegurl"))
      ) {
        playbackEngineRef.current = "native_hls";
        // Native HLS: Safari mpegurl, or TV HEVC remux when MSE has no HEVC
        // (VIDAA often answers "" for mpegurl — still assign src). Element
        // `error` is already bound to failActiveSource, so a dead remux
        // failovers to Kronos/Luna instead of a global "can't play HLS".
        // No JS rendition floor on this path (AVFoundation / TV OS ABR).
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
            setPlayingWidth(video.videoWidth || 0);
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
          attemptAutoplay(
            video,
            onAutoplayBlocked,
            onMutedAutoplayFallback,
            !isTvLikeDevice() && !audiblePlaybackEstablishedRef.current
          );
        }
      } else {
        setLevelsPending(false);
        setBuffering(false);
        setError("Your browser can't play HLS streams.");
      }
    } else {
      playbackEngineRef.current = "native_file";
      if (isHomeHlsProxy) {
        video.crossOrigin = "use-credentials";
      } else if (isWorkerProxy) {
        video.crossOrigin = "anonymous";
      } else {
        // A leftover CORS mode from Luna/HLS makes RD MP4s die instantly.
        video.removeAttribute("crossorigin");
      }
      const rungs = activeSourceRef.current?.qualityRungs ?? [];
      const rungUrl = activeSourceRef.current
        ? pickQualityRungUrl(activeSourceRef.current, qualityTargetRef.current)
        : null;
      video.src = rungUrl || effectiveSrc;
      setLevelsPending(false);
      setBuffering(false);
      // Progressive file: use the source's own quality rungs when the host
      // exposed a ladder. Otherwise seed a single honest height.
      {
        if (rungs.length > 1) {
          const levels = levelsFromQualityRungs(rungs);
          setLevels(levels);
          const startIdx = pickStartLevelIndex(levels, qualityTargetRef.current);
          const startLevel = startIdx >= 0 ? levels[startIdx] : levels[0];
          setQuality(startIdx >= 0 ? startIdx : 0);
          if (startLevel?.height) setPlayingHeight(startLevel.height);
        } else {
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
      }
      onMp4Loaded = () => {
        const vh = video.videoHeight || 0;
        if (vh > 0) {
          const decodedTier = decodedQualityHeight(
            video.videoWidth || 0,
            vh
          );
          setPlayingHeight(decodedTier);
          // Keep a host-provided MP4 ladder. Only invent a single rung when
          // the source is genuinely one file.
          if ((activeSourceRef.current?.qualityRungs?.length ?? 0) < 2) {
            setLevels([{ index: 0, height: decodedTier }]);
          }
          const sid = activeSourceRef.current?.id;
          if (sid) recordDetectedHeight(sid, decodedTier);
        }
        applyResumeSeekAndRearm(video);
        video.removeEventListener("loadedmetadata", onMp4Loaded!);
      };
      video.addEventListener("loadedmetadata", onMp4Loaded);
      if (!userPausedRef.current) {
        attemptAutoplay(
          video,
          onAutoplayBlocked,
          onMutedAutoplayFallback,
          !isTvLikeDevice() && !audiblePlaybackEstablishedRef.current
        );
      }
    }

    return () => {
      dashCancelled = true;
      video.removeEventListener("error", onBoundMediaElementError);
      // reset()/destroy() can synchronously abort XHR and emit loadend. Make
      // that callback stale before teardown starts.
      sourceAttemptControllerRef.current.invalidate(sourceAttempt);
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
    // Deps: stream identity only — see the note above about initialTime.
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
    setPlayingWidth,
    setPlayingBitrate,
    setPlayingFps,
    markSourceFailed,
    syncHlsTracks,
    syncNativeTracks,
    failActiveSource,
    noteHardTransportFailure,
    recordDetectedHeight,
    rejectImplausiblyShortDuration,
    logicalPlayhead,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

    if (PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED && needsRemux) {
      const pendingTarget =
        resumeAtRef.current > RESUME_CAPTURE_MIN_S
          ? resumeAtRef.current
          : initialTime;
      const desiredStart = normalizeRemuxStart(
        pendingTarget,
        fallbackDurationS
      );
      if (remuxStartAtRef.current !== desiredStart) {
        // Reattach to a suffix generated around the saved position. The next
        // pass applies the small local seek after its manifest is ready.
        setRemuxStart(desiredStart);
        return;
      }
    }

    const seekIfEarly = (): void => {
      if (initialTimeAppliedRef.current) return;
      const target =
        resumeAtRef.current > RESUME_CAPTURE_MIN_S ? resumeAtRef.current : initialTime;
      if (target == null || target <= RESUME_SLOW_THRESHOLD_S) return;

      // User scrubbed past resume target — don't yank them back.
      if (logicalPlayhead(video.currentTime) > target + RESUME_ABANDON_SLACK_S) {
        initialTimeAppliedRef.current = true;
        resumeAtRef.current = 0;
        return;
      }

      if (video.readyState < 1) return;
      try {
        video.currentTime = remuxTimelineActiveRef.current
          ? toMediaTime(target, remuxStartAtRef.current)
          : target;
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
  }, [
    initialTime,
    hasStream,
    effectiveSrc,
    logicalPlayhead,
    needsRemux,
    fallbackDurationS,
    setRemuxStart,
  ]);

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
      userPausedRef.current = false;
      setIsPlaying(true);
      setAutoplayHint(null);
    };
    const onPause = () => {
      // Distinguish intentional pause from browser pause-on-stall (readyState drops).
      // If we still have little buffer, treat as underrun (not user pause).
      let ahead = 0;
      try {
        if (video.buffered.length > 0) {
          ahead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        }
      } catch {
        /* ignore */
      }
      if (ahead >= 1.5 && video.readyState >= 3) {
        userPausedRef.current = true;
      }
      setIsPlaying(false);
    };
    const onTimeUpdate = () => {
      onProgressBuf();
      const now = Date.now();
      const t = logicalPlayhead(video.currentTime);
      if (
        pendingRemuxSeekTargetRef.current == null &&
        now - lastTimeUpdateRef.current >= 250
      ) {
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
      /**
       * Which duration to record progress against.
       *
       * A remux's own duration is how much has been remuxed, not how long the
       * title is, so recording against it would mark a film nearly finished
       * within minutes. TMDB's runtime is the honest stand-in while that
       * lasts; if it is unknown, no progress is saved rather than a wrong
       * percentage, since a bad resume point is worse than none.
       */
      const progressDuration = remuxTimelineActiveRef.current
        ? logicalDuration(
            video.duration,
            remuxStartAtRef.current,
            fallbackDurationSRef.current,
            durationProvisionalRef.current
          )
        : durationProvisionalRef.current
          ? fallbackDurationSRef.current
          : video.duration;
      if (
        onProgressRef.current &&
        now - lastProgressSave.current > progressIntervalMs &&
        progressDuration > 0
      ) {
        lastProgressSave.current = now;
        firstProgressSavedRef.current = true;
        onProgressRef.current(t, progressDuration);
      }
      // TV binge: warm next episode sources once we are halfway so next-ep
      // TTFF is near-instant. The watch page also prefetches on mount.
      const nextEpTarget = nextEpisodeTargetRef.current;
      if (
        nextEpTarget &&
        typeof tvId === "number" &&
        shouldPrefetchNextEpisode({
          alreadyPreloaded: nextEpPreloadedRef.current,
          mediaType: mediaType ?? "tv",
          tvId,
          hasNextTarget: true,
          progressDuration,
          currentTime: t,
        })
      ) {
        nextEpPreloadedRef.current = true;
        void preresolvePlayback({
          mediaType: "tv",
          tmdbId: tvId,
          season: nextEpTarget.season,
          episode: nextEpTarget.episode,
        });
      }

      const rollback = remuxRollbackRef.current;
      if (
        rollback &&
        !rollback.confirming &&
        rollback.sourceId === activeSourceRef.current?.id &&
        remuxStartAtRef.current !== rollback.startAtSeconds
      ) {
        if (t > rollback.targetSeconds + 2) {
          failActiveSource(
            "handoff_playhead_mismatch",
            sourceAttemptControllerRef.current.currentToken()
          );
        } else if (
          Math.abs(t - rollback.targetSeconds) <= 2 &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          rollback.confirming = true;
          const confirm = () => {
            if (
              remuxRollbackRef.current === rollback &&
              activeSourceRef.current?.id === rollback.sourceId &&
              Math.abs(logicalPlayhead(video.currentTime) - rollback.targetSeconds) <= 2
            ) {
              remuxRollbackRef.current = null;
              pendingRemuxSeekTargetRef.current = null;
              setIsSwitchingServer(false);
              setRemuxPacking(false);
              setBuffering(false);
            } else if (remuxRollbackRef.current === rollback) {
              rollback.confirming = false;
            }
          };
          if (typeof video.requestVideoFrameCallback === "function") {
            video.requestVideoFrameCallback(() => confirm());
          } else {
            window.requestAnimationFrame(confirm);
          }
        }
      }
    };
    const onDurationChange = () => {
      setDuration(
        remuxTimelineActiveRef.current
          ? logicalDuration(
              video.duration,
              remuxStartAtRef.current,
              fallbackDurationSRef.current,
              durationProvisionalRef.current
            )
          : video.duration
      );
      if (Number.isFinite(video.duration) && video.duration > 0) {
        rejectImplausiblyShortDuration(video.duration);
      }
    };
    const onProgressBuf = () => {
      try {
        if (video.buffered.length > 0) {
          setBufferedEnd(
            remuxTimelineActiveRef.current
              ? toLogicalTime(
                  video.buffered.end(video.buffered.length - 1),
                  remuxStartAtRef.current
                )
              : video.buffered.end(video.buffered.length - 1)
          );
        }
      } catch {
        /* ignore */
      }
    };
    const onWaiting = () => {
      setBuffering(true);
      if (
        everPlayedRef.current &&
        !video.seeking &&
        Date.now() - lastStallFeedbackAtRef.current >= 30_000
      ) {
        const source = activeSourceRef.current;
        if (source) {
          lastStallFeedbackAtRef.current = Date.now();
          emitPlayerFeedback({
            event: "stall",
            sourceId: source.id,
            provider: source.provider,
            selectedHeight: usePlayerStore.getState().playingHeight || undefined,
            audioCodec: source.audioCodec,
            audioLanguage:
              usePlayerStore.getState().audioTracks.find(
                (track) => track.id === usePlayerStore.getState().activeAudioId
              )?.lang,
            engine: playbackEngineRef.current,
          });
        }
      }
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
        recoverHlsPlayback(hls, video, qualityTargetRef.current);
      }, HLS_STALL_RECOVER_DEBOUNCE_MS);
    };
    const onPlaying = () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      networkRecoveriesRef.current = 0;
      if (!video.muted && video.volume > 0) {
        audiblePlaybackEstablishedRef.current = true;
      }
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
      if (!remuxRollbackRef.current) {
        setIsSwitchingServer(false);
        setRemuxPacking(false);
      }
      if (video.readyState >= 2 && (video.currentTime > 0.25 || video.duration > 0)) {
        markEverPlayed();
      }
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
        if (attempt) sourceAttemptControllerRef.current.noteProgress(attempt);
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
        recoverHlsPlayback(hls, video, qualityTargetRef.current);
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
    rejectImplausiblyShortDuration,
    mediaType,
    tvId,
    logicalPlayhead,
  ]);

  const closeDock = useCallback(() => {
    setDockOpen(false);
    setDockSection(null);
  }, []);

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

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(fullscreenElement()));
      // A viewport transition must never land with stale hidden controls.
      resetControlsTimer();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, [resetControlsTimer, setIsFullscreen]);

  // Fullscreen event routing differs across Chromium, Safari/WebKit and TV
  // engines: several of them retarget pointer activity to `document` instead
  // of the React container. Listen in the capture phase while fullscreen so
  // any real mouse/air-mouse activity wakes the chrome, even over the video or
  // at a viewport edge. `mousemove` is retained for older webOS browsers that
  // do not implement Pointer Events completely.
  useEffect(() => {
    const wakeControls = () => {
      if (fullscreenElement()) resetControlsTimer();
    };
    document.addEventListener("pointermove", wakeControls, true);
    document.addEventListener("mousemove", wakeControls, true);
    document.addEventListener("pointerdown", wakeControls, true);
    return () => {
      document.removeEventListener("pointermove", wakeControls, true);
      document.removeEventListener("mousemove", wakeControls, true);
      document.removeEventListener("pointerdown", wakeControls, true);
    };
  }, [resetControlsTimer]);

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

  const requestLogicalSeek = useCallback(
    (requestedSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const fullDuration =
        fallbackDurationSRef.current > 0
          ? fallbackDurationSRef.current
          : usePlayerStore.getState().duration;
      const target = Math.max(
        0,
        fullDuration > 0
          ? Math.min(fullDuration - 0.1, requestedSeconds)
          : requestedSeconds
      );
      remuxSeekGenerationRef.current += 1;
      const generation = remuxSeekGenerationRef.current;
      if (remuxSeekTimerRef.current) {
        clearTimeout(remuxSeekTimerRef.current);
        remuxSeekTimerRef.current = null;
      }
      remuxSeekAbortRef.current?.abort();
      pendingRemuxSeekTargetRef.current = null;

      if (
        !PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED ||
        !remuxTimelineActiveRef.current ||
        !activeSourceRef.current ||
        !tmdbId
      ) {
        video.currentTime = target;
        setCurrentTime(target);
        return;
      }

      try {
        if (
          isLogicalTimeSeekable(
            video.seekable,
            target,
            remuxStartAtRef.current
          )
        ) {
          video.currentTime = toMediaTime(target, remuxStartAtRef.current);
          setCurrentTime(target);
          return;
        }
      } catch {
        // An unreadable TimeRanges object is treated as not seekable; the
        // bounded offset handoff below is safer than guessing.
      }

      pendingRemuxSeekTargetRef.current = target;
      setCurrentTime(target);
      freezeLastVideoFrame(video);
      setRemuxPacking(true);

      remuxSeekTimerRef.current = setTimeout(() => {
        remuxSeekTimerRef.current = null;
        const source = activeSourceRef.current;
        if (
          !source ||
          sourceDelivery(source) !== "remux" ||
          !tmdbId ||
          generation !== remuxSeekGenerationRef.current
        ) {
          return;
        }
        const startAtSeconds = normalizeRemuxStart(target, fullDuration);
        remuxRollbackRef.current = {
          sourceId: source.id,
          startAtSeconds: remuxStartAtRef.current,
          logicalTime: logicalPlayhead(video.currentTime),
          targetSeconds: target,
        };
        resumeAtRef.current = target;
        initialTimeAppliedRef.current = false;
        setBuffering(true);
        const remount = () => {
          if (generation !== remuxSeekGenerationRef.current) return;
          if (remuxStartAtRef.current === startAtSeconds) {
            setSourceReloadGeneration((value) => value + 1);
          } else {
            setRemuxStart(startAtSeconds);
          }
        };
        if (!tmdbId) {
          remount();
          return;
        }
        const prewarmUrl = buildRemuxUrl({
          source,
          mediaType: mediaType ?? "movie",
          tmdbId,
          season: tvSeason,
          episode: tvEpisode,
          audio: audioSelectionRef.current,
          prewarm: true,
          startAtSeconds,
        });
        remuxSeekAbortRef.current?.abort();
        const controller = new AbortController();
        remuxSeekAbortRef.current = controller;
        void prewarmRemuxPosition(prewarmUrl, { signal: controller.signal })
          .catch(() => undefined)
          .then(() => {
            if (controller.signal.aborted) return;
            remount();
          });
      }, REMUX_SEEK_DEBOUNCE_MS);
    },
    [
      logicalPlayhead,
      mediaType,
      setBuffering,
      setCurrentTime,
      setRemuxStart,
      tmdbId,
      tvEpisode,
      tvSeason,
    ]
  );

  const seekRelative = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      requestLogicalSeek(logicalPlayhead(video.currentTime) + seconds);
    },
    [logicalPlayhead, requestLogicalSeek]
  );

  const seekTo = useCallback(
    (time: number) => {
      requestLogicalSeek(time);
    },
    [requestLogicalSeek]
  );

  const seekToPct = useCallback((pct: number) => {
    const duration =
      fallbackDurationSRef.current > 0
        ? fallbackDurationSRef.current
        : usePlayerStore.getState().duration;
    if (duration <= 0) return;
    requestLogicalSeek(duration * pct);
  }, [requestLogicalSeek]);

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
    const container = containerRef.current as FullscreenContainer | null;
    const doc = document as FullscreenDocument;
    const video = videoRef.current as WebkitFullscreenVideo | null;
    const entering = !fullscreenElement();
    const operation = entering
      ? container?.requestFullscreen?.() ?? container?.webkitRequestFullscreen?.()
      : document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.();
    if (entering && !operation && video?.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
      } catch {
        /* unsupported outside a user gesture */
      }
    }
    if (operation && typeof operation.then === "function") {
      void operation.catch(() => undefined);
    }
  }, []);

  // Preset 4K: if we started on 1080 (fast debrid / remembered Luna) and a
  // direct 4K source arrives, switch once. Remux 4K stays picker-only.

  useEffect(() => {
    if (!wantsFourKDiscovery(qualityTargetRef.current)) return;
    if (!activeSource || userSelectedSourceRef.current) return;
    const candidate = findLateFourKSource(activeSource, orderedSources, {
      preferredProvider: getPreferredProvider(),
      preferredHeight: qualityTargetRef.current,
      failedIds: failedSourceIdsRef.current,
    });
    if (!candidate || lateFourKAttemptedRef.current.has(candidate.id)) return;
    lateFourKAttemptedRef.current.add(candidate.id);
    showStatusNotice("4K ready — switching…", 2_200);
    handleSourceChange(candidate);
  }, [
    activeSource,
    everPlayed,
    handleSourceChange,
    orderedSources,
    showStatusNotice,
  ]);

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
    (target: PlayerQualityTarget, announce = true) => {
      const playingHeight = usePlayerStore.getState().playingHeight;
      const alreadyThere = alreadyAtQualityTarget(target, {
        playingHeight,
        source: activeSourceRef.current,
      });
      if (alreadyThere && qualityTargetRef.current === target) {
        return;
      }

      qualityTargetRef.current = target;
      setQualityTarget(target);

      const hls = hlsRef.current;
      const dash = dashRef.current;
      const activeLevels = usePlayerStore.getState().levels;

      if (target === "auto") {
        if (hls) {
          applyPreferredHlsQuality(hls, levelsFromHls(hls), "auto");
        } else if (dash) {
          dash.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: true } } },
          } as Parameters<typeof dash.updateSettings>[0]);
        } else {
          const autoRungs = activeSourceRef.current?.qualityRungs;
          const autoVideo = videoRef.current;
          const autoUrl = activeSourceRef.current
            ? pickQualityRungUrl(activeSourceRef.current, "auto")
            : null;
          if (autoRungs && autoRungs.length > 1 && autoVideo && autoUrl) {
            const time = autoVideo.currentTime;
            const wasPaused = autoVideo.paused;
            autoVideo.src = autoUrl;
            const resume = () => {
              autoVideo.removeEventListener("loadedmetadata", resume);
              if (time > 0.25) {
                try {
                  autoVideo.currentTime = time;
                } catch {
                  /* media not ready */
                }
              }
              if (!wasPaused) void autoVideo.play().catch(() => {});
            };
            autoVideo.addEventListener("loadedmetadata", resume);
          }
        }
        setQuality(-1);
        if (announce) showStatusNotice("Quality set to Auto", 1_800);
        return;
      }

      const option = buildPlayerQualityOptions({
        sources: displaySources,
        activeSourceId: activeSourceRef.current?.id,
        activeLevels,
        selected: target,
        failedIds: failedSourceIdsRef.current,
        discovering: Boolean(isDiscoveringRef.current),
      }).find((candidate) => candidate.value === target);

      if (option?.levelIndex != null && hls) {
        const current =
          hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
        if (current === option.levelIndex) {
          setQuality(option.levelIndex);
          return;
        }
        const switched = switchHlsLevelSmooth(hls, option.levelIndex);
        setQuality(switched);
        if (announce) {
          showStatusNotice(`Switching to ${playerQualityLabel(target)}`, 1_800);
        }
        return;
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
        return;
      }

      const rungs = activeSourceRef.current?.qualityRungs;
      const video = videoRef.current;
      if (rungs && rungs.length > 1 && video && !hls && !dash) {
        const nextUrl =
          option?.levelIndex != null
            ? rungs[option.levelIndex]?.url
            : pickQualityRungUrl(activeSourceRef.current!, target);
        if (nextUrl) {
          const time = video.currentTime;
          const wasPaused = video.paused;
          video.src = nextUrl;
          const resume = () => {
            video.removeEventListener("loadedmetadata", resume);
            if (time > 0.25) {
              try {
                video.currentTime = time;
              } catch {
                /* media not ready */
              }
            }
            if (!wasPaused) void video.play().catch(() => {});
          };
          video.addEventListener("loadedmetadata", resume);
          setQuality(option?.levelIndex ?? -1);
          if (announce) {
            showStatusNotice(`Switching to ${playerQualityLabel(target)}`, 1_800);
          }
          return;
        }
      }

      if (alreadyThere) {
        return;
      }

      const replacement = option?.sourceId
        ? orderedSourcesRef.current.find((source) => source.id === option.sourceId)
        : undefined;
      if (!replacement || replacement.id === activeSourceRef.current?.id) {
        return;
      }

      userSelectedSourceRef.current = true;
      setQuality(-1);
      handleSourceChange(replacement);
      if (announce) {
        showStatusNotice(
          `Switching source for ${playerQualityLabel(target)}`,
          2_400
        );
      }
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
    handleQualityTargetChange(profileQuality, false);
  }, [profileQuality, handleQualityTargetChange]);

  const handleUserQualityTargetChange = useCallback(
    (target: PlayerQualityTarget) => {
      userSelectedQualityRef.current = true;
      handleQualityTargetChange(target);
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
    // Volume level persists. Mute does not — a TV autoplay fallback used to
    // write muted=1 and every later title started silent.
    if (v) {
      const state = usePlayerStore.getState();
      const volume = state.volume > 0 ? state.volume : 1;
      v.volume = volume;
      v.muted = false;
      if (state.volume <= 0) setVolume(volume);
      if (state.isMuted) setIsMuted(false);
    }
  }, [setSpeed, setIsMuted, setVolume]);

  const handleSubtitleChange = useCallback(
    (trackId: number | null) => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (trackId === null) {
        userSelectedSubtitleRef.current = true;
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
      userSelectedSubtitleRef.current = true;
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
      userSelectedAudioRef.current = true;
      manualAudioTrackRef.current = {
        sourceId: activeSourceRef.current?.id ?? "",
        trackId,
        lang: track?.lang ?? null,
      };
      audioSelectionRef.current = {
        ...audioSelectionRef.current,
        preference: "preferred",
        preferredLanguage: track?.lang ?? audioSelectionRef.current.preferredLanguage,
      };
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
          // Mutating the browser's AudioTrackList is the only way to switch
          // audio on the native path — there is no declarative API. The rule
          // flags this as "modifying videoRef", but the ref itself is never
          // reassigned; this writes to a DOM object it points at, from an
          // event handler, which is exactly where imperative media calls belong.
          // eslint-disable-next-line react-hooks/immutability
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

    const preferred = pickPreferredSubtitle(tracks, "en")?.id ?? tracks[0].id;
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
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      const tvMode = isTvLikeDevice();
      const isBack = isRemoteBackEvent(e);

      if (isBack) {
        e.preventDefault();
        if (shortcutsOpenRef.current) {
          setShortcutsOpen(false);
        } else if (dockOpenRef.current) {
          closeDock();
        } else {
          if (onBack) onBack();
          else window.history.back();
        }
        resetControlsTimer();
        return;
      }
      if (shortcutsOpenRef.current) {
        if (e.key === "Escape" || e.key === "?" || (e.key === "/" && e.shiftKey)) {
          e.preventDefault();
          setShortcutsOpen(false);
          resetControlsTimer();
        }
        return;
      }
      if (dockOpenRef.current) return;
      if (!hasStream) return;

      // webOS/Tizen and many Android-TV browsers report media remotes as legacy
      // key codes even when KeyboardEvent.key is empty.
      if (e.keyCode === 415 || e.key === "MediaPlayPause" || e.key === "MediaPlay") {
        e.preventDefault();
        togglePlay();
        resetControlsTimer();
        return;
      }
      if (e.keyCode === 19 || e.key === "MediaPause") {
        e.preventDefault();
        const video = videoRef.current;
        if (video && !video.paused) togglePlay();
        resetControlsTimer();
        return;
      }
      if (e.keyCode === 412 || e.key === "MediaRewind") {
        e.preventDefault();
        seekRelative(-10);
        resetControlsTimer();
        return;
      }
      if (e.keyCode === 417 || e.key === "MediaFastForward") {
        e.preventDefault();
        seekRelative(10);
        resetControlsTimer();
        return;
      }

      if (tvMode && /^Arrow(?:Left|Right|Up|Down)$/.test(e.key)) {
        // Sliders own their left/right adjustment. Everything else uses spatial
        // focus, so the D-pad never unexpectedly seeks or changes volume.
        if (isEditable || target?.getAttribute("role") === "slider") return;
        e.preventDefault();
        setShowControls(true);
        const root = containerRef.current;
        const current =
          target && root?.contains(target) && isInteractivePlayerTarget(target)
            ? target
            : null;
        if (root && current) {
          moveSpatialFocus(root, current, e.key as SpatialDirection);
        } else {
          requestAnimationFrame(() => {
            const first = root?.querySelector<HTMLElement>(
              "button[aria-label='Pause'], button[aria-label='Play'], button:not([disabled])"
            );
            first?.focus();
          });
        }
        resetControlsTimer();
        return;
      }

      if (isEditable) return;
      // Only sliders/fields own the arrows. A focused Play button used to
      // swallow skip/volume until the video itself was clicked.
      const arrowOwnedByField =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.getAttribute("role") === "slider";
      if (
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown") &&
        arrowOwnedByField
      ) {
        return;
      }

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
        case "j":
          e.preventDefault();
          seekRelative(-10);
          break;
        case "ArrowRight":
        case "l":
          e.preventDefault();
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

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
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
    onBack,
    closeDock,
    setShowControls,
    resetControlsTimer,
  ]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (isInteractivePlayerTarget(e.target)) {
      touchStart.current = null;
      resetControlsTimer();
      return;
    }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (isInteractivePlayerTarget(e.target)) {
      touchStart.current = null;
      resetControlsTimer();
      return;
    }
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    suppressVideoClickUntilRef.current = performance.now() + 750;

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_MIN_PX) {
      seekRelative(dx > 0 ? SWIPE_SEEK_SECONDS : -SWIPE_SEEK_SECONDS);
    } else if (Math.abs(dy) > SWIPE_MIN_PX) {
      adjustVolume(dy < 0 ? 0.15 : -0.15);
    } else if (!showControls && isPlaying) {
      // First tap on hidden chrome reveals it without unexpectedly pausing.
      resetControlsTimer();
      return;
    } else {
      togglePlay();
    }
    resetControlsTimer();
  };

  const levels = usePlayerStore((s) => s.levels);

  const waitingForSource = !hasStream && (sourcesLoading || !sourcesError);
  const controlsPinned = !hasStream || !!error || waitingForSource || showHunting;
  const controlsVisible = showControls || controlsPinned || !!error;

  const qualityTargets = useMemo(
    () =>
      buildPlayerQualityOptions({
        sources: displaySources,
        activeSourceId: activeSource?.id,
        activeLevels: levels,
        selected: qualityTarget,
        failedIds: new Set(failedSourceIds),
        discovering: Boolean(isDiscoveringSources),
        playingHeight,
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

  /**
   * Read the failed-source STATE here, not `failedSourceIdsRef`. This value is
   * computed during render and decides whether the error card offers "Next
   * source"; a ref is invisible to React, so a source failing would not
   * re-evaluate it. The ref and this state are written together everywhere
   * (see `markSourceFailed`), so this is the same data with correct tracking.
   */
  const hasAlternateSource = orderedSources.some(
    (s) => !failedSourceIds.includes(s.id) && s.id !== activeSource?.id
  );
  const isExhausted = error === ALL_SOURCES_FAILED_MSG;
  /**
   * Does this error actually stop the viewer watching?
   *
   * Roster-level verdicts ("no playable server for this title") are produced by
   * discovery/failover bookkeeping, which can conclude the roster is exhausted
   * while the currently attached stream is playing perfectly well — the reported
   * symptom being a full-screen "no sources found" card thrown over a running
   * video. Playback that has started and has not faulted is the stronger signal,
   * so the card is suppressed in that case and the error stays available through
   * the dock instead.
   *
   * A media-element fault (`video.error`) still counts as blocking, so a genuine
   * decode/network failure is never silently swallowed.
   */
  const errorBlocksPlayback = !everPlayed || mediaFaulted;
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
      className="player-shell group/player relative h-full min-h-0 w-full cursor-none bg-black select-none data-[ui=1]:cursor-auto"
      data-ui={
        controlsVisible || showHunting || !!error || !!sourcesError
          ? "1"
          : "0"
      }
      onMouseMove={resetControlsTimer}
      onMouseLeave={() => {
        if (dockOpenRef.current || shortcutsOpenRef.current) return;
        // In fullscreen, reaching the viewport edge can emit mouseleave even
        // though the pointer never left the player. The document-level motion
        // listener above owns visibility until fullscreen is exited.
        if (fullscreenElement()) return;
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
        ref={scoutRef}
        muted
        playsInline
        preload="none"
        className="pointer-events-none hidden"
        aria-hidden
      />
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
          if (performance.now() < suppressVideoClickUntilRef.current) return;
          if (dockOpen) closeDock();
          if (autoplayHint === MUTED_AUTOPLAY_HINT) {
            const v = videoRef.current;
            if (v) v.muted = false;
            setAutoplayHint(null);
            return;
          }
          if (!isPlaying) {
            setShowControls(true);
            resetControlsTimer();
            return;
          }
          togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
        playsInline
      />

      {showSeekSpinner ? (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
          role="status"
          aria-live="polite"
          aria-label="Buffering"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <Loader2 className="h-9 w-9 animate-spin text-white" />
          </span>
        </div>
      ) : null}

      <LoadingScreen
        visible={showHunting}
        serverName={huntingName}
        title={title}
        backdropUrl={poster}
        posterUrl={artwork}
        sourceCount={Math.max(sourceCount, healthySourceCount)}
        discovering={Boolean(isDiscoveringSources)}
        status={resumeNotice ?? loadingStatus}
        premiumCount={premiumSourceCount(orderedSources)}
        chosenIndex={activeSourceIndex - 1}
        bufferFill={bloomBufferFill}
        waitingForFourK={
          qualityTarget === 2160 &&
          !orderedSources.some((source) => sourceMaxHeight(source) >= 2160)
        }
        waitHint={
          needsRemux && hasStream
            ? loadingStatus
            : resumeNotice ?? null
        }
        signatureSeed={`${mediaType}:${tmdbId}`}
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
            Switching…
            {needsRemux ? " Repackaging for your browser." : ""}
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
      {showBufferingChip && !newSourceNotice && !showSeekSpinner && (
        <div
          className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/12 bg-black/60 px-3.5 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-white/50" />
            <span className="relative m-auto h-1.5 w-1.5 rounded-full bg-white" />
          </span>
          <span>
            Catching up
            {playingHeight > 0 ? ` · ${formatResolutionLabel(playingHeight)}` : ""}
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
          least visible and inert, not actively broken.

          Never blanket a stream that is actually playing (see
          `errorBlocksPlayback`): a roster-level verdict can arrive while the
          video is running fine, and covering working playback with "no sources"
          is worse than the problem it reports. */}
      {error && errorBlocksPlayback && (
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

      {/* Pause: only the small center chip starts playback — the title opens info. */}
      {hasStream && !isPlaying && !buffering && !error && !showHunting && (
        <>
          <div className="pointer-events-none absolute inset-0 z-[5] bg-black/25" />
          <button
            type="button"
            onClick={() => {
              if (dockOpen) closeDock();
              togglePlay();
            }}
            className="absolute left-1/2 top-1/2 z-[6] flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-white/95 shadow-lg transition-all duration-150 hover:scale-[1.08] hover:bg-white"
            aria-label="Play"
          >
            <Play className="ml-[3px] h-6 w-6 fill-[#111] text-[#111]" aria-hidden />
          </button>
        </>
      )}

      {/* Title + Paused overlaid on video (LordFlix) — stays while paused, above controls */}
      {!isPlaying && hasStream && !showHunting && !error && (
        onTitleClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTitleClick();
            }}
            className="absolute z-10 max-w-md animate-in fade-in duration-300 text-left"
            style={{ bottom: 72, left: 24 }}
          >
            <h3 className="m-0 text-base font-semibold text-white drop-shadow-md">{title}</h3>
            <p className="m-0 mt-0.5 text-[0.8rem] leading-relaxed text-white/50 drop-shadow">
              {autoplayHint === SLEEP_TIMER_PAUSED_MSG ? autoplayHint : "Paused"}
            </p>
          </button>
        ) : (
          <div
            className="pointer-events-none absolute z-10 max-w-md animate-in fade-in duration-300"
            style={{ bottom: 72, left: 24 }}
          >
            <h3 className="m-0 text-base font-semibold text-white drop-shadow-md">{title}</h3>
            <p className="m-0 mt-0.5 text-[0.8rem] leading-relaxed text-white/50 drop-shadow">
              {autoplayHint === SLEEP_TIMER_PAUSED_MSG ? autoplayHint : "Paused"}
            </p>
          </div>
        )
      )}

      {swipeHint !== "hidden" && (
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

      <SkipIntroButton onSkip={seekTo} />


      <PlayerControls
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
        onTitleClick={onTitleClick}
        previewSrc={previewSrc}
        onHoverTime={setHoverTime}
        tvId={tvId}
        tvSeasons={tvSeasons}
        tvSeason={tvSeason}
        tvEpisode={tvEpisode}
        onSelectEpisode={onSelectEpisode}
        sleepMinutes={sleepMinutes}
        onSleepMinutesChange={setSleepMinutes}
        expectedDurationS={fallbackDurationS}
        tmdbId={tmdbId}
      />
    </div>
  );
}
