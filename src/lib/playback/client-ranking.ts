import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  HD_FLOOR_HEIGHT,
  isEnglishPreferredSource,
  isFasterSource,
  isMeaningfullyRicherSource,
  isMultiRendition,
  pickDefaultSource,
  sourceAudioLanguageRank,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";

const STARTUP_UHD_HEIGHT = 2160;
/** Same-session roster jump must clear this many pixels to count as taller. */
export const ROSTER_HEIGHT_UPGRADE_PX = 100;

export interface StartupSourceDecision {
  immediate: PlaybackSource | null;
  /** A cold 4K remux worth preparing without delaying the first frame. */
  deferredFourK: PlaybackSource | null;
  reason: "ranked_best" | "fast_start_direct_hd" | "no_source";
}

export interface RosterUpgradeDecision {
  current: PlaybackSource;
  candidate: PlaybackSource;
  everPlayed: boolean;
  fourKStartup: FourKStartupPreference;
  userPicked: boolean;
}

function isDirectHdSource(source: PlaybackSource): boolean {
  return (
    sourceDelivery(source) === "direct" &&
    sourceMaxHeight(source) >= HD_FLOOR_HEIGHT &&
    isEnglishPreferredSource(source)
  );
}

/** True when the candidate is a better household language than the current row. */
export function isLanguageRescueUpgrade(
  current: PlaybackSource,
  candidate: PlaybackSource
): boolean {
  return sourceAudioLanguageRank(candidate) > sourceAudioLanguageRank(current);
}

function isRemuxUhdSource(source: PlaybackSource): boolean {
  return (
    sourceDelivery(source) === "remux" &&
    sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT &&
    isEnglishPreferredSource(source)
  );
}

/**
 * Cold-start roster gate. `pickClientStartupSource` already prefers a direct
 * HD first frame; this blocks a later `betterHeight` / richer / faster
 * comparison from yanking that pick into a remux before the first healthy
 * play. Maximum quality and an explicit user pick are the only overrides.
 */
export function shouldAdoptRosterUpgrade(
  options: RosterUpgradeDecision
): boolean {
  const { current, candidate, everPlayed, fourKStartup, userPicked } = options;
  if (candidate.id === current.id) return false;
  if (userPicked) return false;

  const currentLang = sourceAudioLanguageRank(current);
  const candidateLang = sourceAudioLanguageRank(candidate);
  if (candidateLang < currentLang) return false;

  const candidateRemux = sourceDelivery(candidate) === "remux";
  const currentEnglishDirect =
    sourceDelivery(current) === "direct" &&
    sourceMaxHeight(current) >= HD_FLOOR_HEIGHT &&
    isEnglishPreferredSource(current);
  // Hindi/Arabic 1080 is not a reason to block English remux 4K.
  if (candidateRemux && currentEnglishDirect && fourKStartup !== "maximum") {
    return false;
  }

  if (everPlayed && candidateLang <= currentLang) return false;
  if (candidateLang > currentLang) return true;

  const betterMulti =
    isMultiRendition(candidate) && !isMultiRendition(current);
  const betterHeight =
    sourceMaxHeight(candidate) >
    sourceMaxHeight(current) + ROSTER_HEIGHT_UPGRADE_PX;
  const betterTransport = isFasterSource(current, candidate);
  const richerEncode = isMeaningfullyRicherSource(current, candidate);
  return betterMulti || betterHeight || betterTransport || richerEncode;
}

/**
 * Final client-side startup policy. In fast mode a cold 4K remux never holds
 * a ready direct 1080p+ source hostage; the remux is returned separately so
 * the player can prewarm it in the background. Native/direct 4K still starts
 * immediately because it has no server preparation cost.
 */
export function pickClientStartupSource(
  sources: readonly PlaybackSource[],
  options: {
    preferredProvider?: string | null;
    preferredHeight?: "auto" | number | null;
    fourKStartup: FourKStartupPreference;
  }
): StartupSourceDecision {
  const roster = [...sources];
  const remuxFourK = pickDefaultSource(
    roster.filter(isRemuxUhdSource),
    options.preferredProvider,
    STARTUP_UHD_HEIGHT
  );
  const directHdPool = roster.filter(isDirectHdSource);

  if (options.fourKStartup === "maximum") {
    const fourK = pickDefaultSource(
      roster.filter((source) => sourceMaxHeight(source) >= STARTUP_UHD_HEIGHT),
      options.preferredProvider,
      STARTUP_UHD_HEIGHT
    );
    if (fourK) {
      return { immediate: fourK, deferredFourK: null, reason: "ranked_best" };
    }
    const fallback = pickDefaultSource(
      roster,
      options.preferredProvider,
      options.preferredHeight
    );
    return fallback
      ? { immediate: fallback, deferredFourK: null, reason: "ranked_best" }
      : { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const best = pickDefaultSource(
    roster,
    options.preferredProvider,
    options.preferredHeight
  );
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }

  const directHd = pickDefaultSource(
    directHdPool,
    options.preferredProvider,
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
