import type { PlaybackDecision, PlaybackSource } from "./types";
import {
  isEnglishPreferredSource,
  isHouseholdStartLanguage,
  sourceAudioLanguageCode,
  sourceAudioLanguageRank,
} from "./source-facts";
import { isSourcePlayableHere, sourceDelivery, normalizedBitrate } from "./source-quality";
import { isNeverAutoDefaultUrl } from "./poison-url";
import { isMoviePackRelease } from "./debrid/torrentio";
import { filterHighQualitySources } from "./quality-floor";

export const STARTUP_UHD_HEIGHT = 2160;
export const HD_FLOOR_HEIGHT = 1080;

export interface DecidePlaybackOptions {
  preferredProvider?: string | null;
  preferredHeight?: "auto" | number | null;
  fourKStartup?: "fast" | "maximum" | null;
  contentClass?: string | null;
  failedIds?: readonly string[];
  remuxAvailable?: boolean;
}

export function shouldLockFourKStartup(
  preferredHeight: "auto" | number | null | undefined
): boolean {
  return preferredHeight === 2160 || preferredHeight === "auto";
}

function failedSet(ids: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(ids ?? []);
}

function sourceMaxHeight(source: PlaybackSource): number {
  if (typeof source.maxHeight === "number" && source.maxHeight > 0) {
    return source.maxHeight;
  }
  const raw = source.quality;
  if (!raw || raw === "auto") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDirectHd(source: PlaybackSource): boolean {
  return (
    sourceDelivery(source) === "direct" &&
    sourceMaxHeight(source) >= HD_FLOOR_HEIGHT
  );
}

export function isPackSource(source: PlaybackSource): boolean {
  return (
    source.titleMatch === "pack" ||
    isMoviePackRelease(source.label || source.title || "")
  );
}

/**
 * Household language policy:
 * English preferred titles stay in the auto pool when stamped English;
 * unlabeled direct HD is allowed as a fallback so native sources can start.
 */
export function autoLanguagePool(
  sources: readonly PlaybackSource[],
  contentClass?: string | null
): PlaybackSource[] {
  const preferredEn = sources.filter((source) =>
    isEnglishPreferredSource(source, contentClass)
  );
  const preferredEnDirectHd = preferredEn.filter(isDirectHd);
  if (preferredEnDirectHd.length) return preferredEn;

  if (preferredEn.length) {
    const undDirectHd = sources.filter(
      (source) => sourceAudioLanguageCode(source) === "und" && isDirectHd(source)
    );
    if (undDirectHd.length) return [...preferredEn, ...undDirectHd];
    return preferredEn;
  }

  const unlabeled = sources.filter((source) => {
    const code = sourceAudioLanguageCode(source);
    return code === "und" || code === "xx";
  });
  const animeOriginal = sources.filter(
    (source) => sourceAudioLanguageRank(source, contentClass) >= 1
  );
  if (unlabeled.length) return unlabeled;
  if (animeOriginal.length) return animeOriginal;
  return [...sources];
}

/** Collection dumps never auto-play when a single-title row exists. */
export function autoIdentityPool(
  sources: readonly PlaybackSource[]
): PlaybackSource[] {
  const singles = sources.filter((source) => !isPackSource(source));
  return singles.length ? singles : [...sources];
}

function isDirectHdSource(source: PlaybackSource): boolean {
  return isDirectHd(source) && isHouseholdStartLanguage(source);
}

function isEnglishRemuxUhd(
  source: PlaybackSource,
  contentClass?: string | null
): boolean {
  return (
    sourceDelivery(source) === "remux" &&
    sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
    isEnglishPreferredSource(source, contentClass)
  );
}

function heightTier(height: number): number {
  if (height >= STARTUP_UHD_HEIGHT) return 4;
  if (height >= HD_FLOOR_HEIGHT) return 3;
  if (height >= 720) return 2;
  if (height <= 0) return 1;
  return 0;
}

function isAutoEligible(source: PlaybackSource): boolean {
  if (!isSourcePlayableHere(source)) return false;
  if (source.verified === false) return false;
  if (source.probe?.ok === false) return false;
  if (isNeverAutoDefaultUrl(source.url)) return false;
  return true;
}

function autoQualityPool(sources: readonly PlaybackSource[]): PlaybackSource[] {
  const eligible = sources.filter(isAutoEligible);
  return filterHighQualitySources(eligible.length ? eligible : [...sources]);
}

function compareForAutoStart(
  a: PlaybackSource,
  b: PlaybackSource,
  options: DecidePlaybackOptions,
  targetHeight: DecidePlaybackOptions["preferredHeight"]
): number {
  const aH = sourceMaxHeight(a);
  const bH = sourceMaxHeight(b);
  const explicit = typeof targetHeight === "number" ? targetHeight : null;

  if (explicit != null) {
    const aMeet = aH >= explicit ? 1 : 0;
    const bMeet = bH >= explicit ? 1 : 0;
    if (aMeet !== bMeet) return bMeet - aMeet;
  }

  // Highest resolution tier wins: 4K (4) > 1080p (3) > 720p (2) > auto/probed (1)
  const aTier = heightTier(aH);
  const bTier = heightTier(bH);
  if (aTier !== bTier) return bTier - aTier;
  if (aTier !== 1 && aH !== bH) return bH - aH;

  const aDirect = sourceDelivery(a) === "direct" ? 1 : 0;
  const bDirect = sourceDelivery(b) === "direct" ? 1 : 0;
  if (aDirect !== bDirect) return bDirect - aDirect;

  const aDebrid = a.origin === "debrid" ? 1 : 0;
  const bDebrid = b.origin === "debrid" ? 1 : 0;
  if (aDebrid !== bDebrid) return bDebrid - aDebrid;

  const rate = normalizedBitrate(b) - normalizedBitrate(a);
  if (rate !== 0) return rate;

  const pref = (options.preferredProvider || "").trim().toLowerCase();
  if (pref) {
    const aPref = `${a.provider} ${a.label}`.toLowerCase().includes(pref) ? 1 : 0;
    const bPref = `${b.provider} ${b.label}`.toLowerCase().includes(pref) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;
  }
  return a.id.localeCompare(b.id);
}

function pickFrom(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions,
  height: DecidePlaybackOptions["preferredHeight"]
): PlaybackSource | null {
  const pool = autoQualityPool(sources).filter(
    (source) => isAutoEligible(source) || isSourcePlayableHere(source)
  );
  if (!pool.length) return null;
  return [...pool].sort((a, b) => compareForAutoStart(a, b, options, height))[0] ?? null;
}

/**
 * The auto-start decider.
 * Always prioritizes highest available decodable resolution (4K > 1080p > 720p).
 */
export function decidePlayback(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackDecision {
  const live = sources.filter((source) => !failedSet(options.failedIds).has(source.id));
  const remuxAllowed = options.remuxAvailable !== false;
  const playableLive = remuxAllowed
    ? live
    : live.filter((s) => sourceDelivery(s) !== "remux");

  const roster = autoLanguagePool(
    autoIdentityPool(playableLive),
    options.contentClass
  );
  if (!roster.length) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  // Direct 4K check
  const identity = autoIdentityPool(playableLive);
  const fourKDirect = pickFrom(
    identity.filter(
      (source) =>
        sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
        sourceDelivery(source) === "direct" &&
        isHouseholdStartLanguage(source)
    ),
    options,
    STARTUP_UHD_HEIGHT
  );
  if (fourKDirect) {
    return { immediate: fourKDirect, deferredFourK: null, reason: "ranked_best" };
  }

  // Remux 4K check (if remux allowed)
  if (remuxAllowed) {
    const fourKRemux = pickFrom(
      identity.filter(
        (source) =>
          sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
          sourceDelivery(source) === "remux" &&
          isHouseholdStartLanguage(source)
      ),
      options,
      STARTUP_UHD_HEIGHT
    );
    if (fourKRemux) {
      return { immediate: fourKRemux, deferredFourK: null, reason: "ranked_best" };
    }
  }

  // Best ranked source in roster (highest quality available)
  const best = pickFrom(roster, options, options.preferredHeight);
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  return { immediate: best, deferredFourK: null, reason: "ranked_best" };
}

export function decideImmediateSource(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackSource | null {
  return decidePlayback(sources, options).immediate;
}
