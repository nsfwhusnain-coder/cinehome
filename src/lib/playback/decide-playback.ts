import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  isEnglishPreferredSource,
  isPackSource,
  sourceAudioLanguageRank,
} from "./source-facts";
import {
  HD_FLOOR_HEIGHT,
  pickDefaultSource,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";

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

/**
 * English (or unlabeled) first. If none exist, unknown-locale / anime original.
 * Explicit foreign only when the roster has nothing else.
 */
export function autoLanguagePool(
  sources: readonly PlaybackSource[],
  contentClass?: string | null
): PlaybackSource[] {
  const preferred = sources.filter((source) =>
    isEnglishPreferredSource(source, contentClass)
  );
  if (preferred.length) return preferred;
  const secondary = sources.filter(
    (source) => sourceAudioLanguageRank(source, contentClass) >= 1
  );
  return secondary.length ? secondary : [...sources];
}

/** Collection dumps never auto-play when a single-title row exists. */
export function autoIdentityPool(
  sources: readonly PlaybackSource[]
): PlaybackSource[] {
  const singles = sources.filter((source) => !isPackSource(source));
  return singles.length ? singles : [...sources];
}

function isDirectHdSource(
  source: PlaybackSource,
  contentClass?: string | null
): boolean {
  return (
    sourceDelivery(source) === "direct" &&
    sourceMaxHeight(source) >= HD_FLOOR_HEIGHT &&
    isEnglishPreferredSource(source, contentClass)
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

function pickFrom(
  sources: readonly PlaybackSource[],
  options: DecidePlaybackOptions,
  height: DecidePlaybackOptions["preferredHeight"]
): PlaybackSource | null {
  return pickDefaultSource(
    [...sources],
    options.preferredProvider,
    height
  );
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

  if (fourKStartup === "maximum") {
    const fourK = pickFrom(
      roster.filter((source) => sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT),
      options,
      STARTUP_UHD_HEIGHT
    );
    if (fourK) {
      return { immediate: fourK, deferredFourK: null, reason: "ranked_best" };
    }
    const fallback = pickFrom(roster, options, options.preferredHeight);
    return fallback
      ? { immediate: fallback, deferredFourK: null, reason: "ranked_best" }
      : { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const best = pickFrom(roster, options, options.preferredHeight);
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const directHd = pickFrom(
    roster.filter((source) => isDirectHdSource(source, options.contentClass)),
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
