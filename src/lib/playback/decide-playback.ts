import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  isEnglishPreferredSource,
  isHouseholdStartLanguage,
  isPackSource,
  sourceAudioLanguageCode,
  sourceAudioLanguageRank,
} from "./source-facts";
import { isNeverAutoDefaultUrl } from "./poison-url";
import {
  HD_FLOOR_HEIGHT,
  isSourcePlayableHere,
  normalizedBitrate,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";
import { filterHighQualitySources } from "./quality-floor";

const STARTUP_UHD_HEIGHT = 2160;

export type PlaybackDecisionReason =
  | "ranked_best"
  | "fast_start_direct_hd"
  | "no_source";

export interface PlaybackDecision {
  immediate: PlaybackSource | null;
  deferredFourK: PlaybackSource | null;
  reason: PlaybackDecisionReason;
}

export interface DecidePlaybackOptions {
  preferredProvider?: string | null;
  preferredHeight?: "auto" | number | null;
  fourKStartup?: FourKStartupPreference;
  contentClass?: string | null;
  failedIds?: ReadonlySet<string> | readonly string[];
}

function failedSet(
  failedIds: DecidePlaybackOptions["failedIds"]
): ReadonlySet<string> {
  if (!failedIds) return new Set();
  return failedIds instanceof Set ? failedIds : new Set(failedIds);
}

function isDirectHd(source: PlaybackSource): boolean {
  return (
    sourceDelivery(source) === "direct" &&
    sourceMaxHeight(source) >= HD_FLOOR_HEIGHT
  );
}

/**
 * Stamped English wins the auto pool. Unlabeled (`und`) is not English —
 * it is only kept when there is no stamped-English *direct* HD, so Luna
 * can still start while Hades remux 4K prepares.
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
  return (
    isDirectHd(source) && isHouseholdStartLanguage(source)
  );
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
 * The only auto-start function. Scraper, playback API, and player all call
 * this. Remux 4K is deferred whenever English direct HD is ready.
 */
export function decidePlayback(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackDecision {
  const fourKStartup = options.fourKStartup ?? "fast";
  const live = sources.filter((source) => !failedSet(options.failedIds).has(source.id));
  const roster = autoLanguagePool(
    autoIdentityPool(live),
    options.contentClass
  );
  if (!roster.length) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const remuxFourK = pickFrom(
    roster.filter((source) => isEnglishRemuxUhd(source, options.contentClass)),
    options,
    STARTUP_UHD_HEIGHT
  );

  // Ultra (2160) and Maximum both start on 4K once. Never open 1080 and
  // remount when 4K arrives — that reload is the UX the household rejected.
  const lockFourK =
    fourKStartup === "maximum" || options.preferredHeight === STARTUP_UHD_HEIGHT;

  if (lockFourK) {
    // Ultra searches the identity pool, not the English-only auto pool.
    // Unlabeled Quasar/Solstice 4K used to be dropped the moment Kronos
    // (stamped English 1080) appeared — preset 4K then started at 1080.
    const identity = autoIdentityPool(live);
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
    const fallback = pickFrom(
      roster.filter((source) => sourceDelivery(source) !== "remux"),
      options,
      options.preferredHeight
    );
    const start = fallback ?? pickFrom(roster, options, options.preferredHeight);
    if (!start) {
      return { immediate: null, deferredFourK: null, reason: "no_source" };
    }
    return {
      immediate: start,
      deferredFourK:
        remuxFourK && remuxFourK.id !== start.id ? remuxFourK : null,
      reason: remuxFourK && remuxFourK.id !== start.id
        ? "fast_start_direct_hd"
        : "ranked_best",
    };
  }

  const best = pickFrom(roster, options, options.preferredHeight);
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const directHd = pickFrom(
    roster.filter(isDirectHdSource),
    options,
    options.preferredHeight
  );
  if (directHd && remuxFourK) {
    const deferRemux =
      sourceMaxHeight(directHd) < STARTUP_UHD_HEIGHT ? remuxFourK : null;
    return {
      immediate: directHd,
      deferredFourK: deferRemux,
      reason: deferRemux ? "fast_start_direct_hd" : "ranked_best",
    };
  }

  return { immediate: best, deferredFourK: null, reason: "ranked_best" };
}

export function decideImmediateSource(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions = {}
): PlaybackSource | null {
  return decidePlayback(sources, options).immediate;
}
