import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  decidePlayback,
  type DecidePlaybackOptions,
} from "./decide-playback";
import {
  isEnglishPreferredSource,
  sourceAudioLanguageRank,
} from "./source-facts";
import {
  HD_FLOOR_HEIGHT,
  isFasterSource,
  isMeaningfullyRicherSource,
  isMultiRendition,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";

export const ROSTER_HEIGHT_UPGRADE_PX = 100;
const STARTUP_UHD = 2160;

export interface SelectActiveSourceInput {
  roster: readonly PlaybackSource[];
  active: PlaybackSource | null;
  failedIds?: ReadonlySet<string> | readonly string[];
  userPicked: boolean;
  everPlayed: boolean;
  autoUpgraded: boolean;
  fourKStartup: FourKStartupPreference;
  preferredProvider?: string | null;
  preferredHeight?: "auto" | number | null;
  contentClass?: string | null;
  urlRefreshPending?: boolean;
}

export interface SelectActiveSourceResult {
  next: PlaybackSource | null;
  deferredFourK: PlaybackSource | null;
  replace: boolean;
  reason:
    | "url_refresh"
    | "start"
    | "failover"
    | "language_rescue"
    | "roster_upgrade"
    | "hold";
}

export function isLanguageRescueUpgrade(
  current: PlaybackSource,
  candidate: PlaybackSource,
  contentClass?: string | null
): boolean {
  return (
    sourceAudioLanguageRank(candidate, contentClass) >
    sourceAudioLanguageRank(current, contentClass)
  );
}

export function shouldAdoptRosterUpgrade(options: {
  current: PlaybackSource;
  candidate: PlaybackSource;
  everPlayed: boolean;
  fourKStartup: FourKStartupPreference;
  userPicked: boolean;
  contentClass?: string | null;
  preferredHeight?: "auto" | number | null;
}): boolean {
  const {
    current,
    candidate,
    everPlayed,
    fourKStartup,
    userPicked,
    contentClass,
    preferredHeight,
  } = options;
  if (candidate.id === current.id) return false;
  if (userPicked) return false;

  const currentLang = sourceAudioLanguageRank(current, contentClass);
  const candidateLang = sourceAudioLanguageRank(candidate, contentClass);
  if (candidateLang < currentLang && sourceMaxHeight(candidate) < STARTUP_UHD) {
    return false;
  }

  const candidateRemux = sourceDelivery(candidate) === "remux";
  const currentEnglishDirect =
    sourceDelivery(current) === "direct" &&
    sourceMaxHeight(current) >= HD_FLOOR_HEIGHT &&
    isEnglishPreferredSource(current, contentClass);
  if (
    candidateRemux &&
    currentEnglishDirect &&
    fourKStartup !== "maximum" &&
    preferredHeight !== 2160
  ) {
    return false;
  }

  if (candidateLang > currentLang) return true;

  const lockFourK =
    fourKStartup === "maximum" || preferredHeight === 2160;
  if (
    lockFourK &&
    sourceMaxHeight(candidate) >= STARTUP_UHD &&
    sourceMaxHeight(current) < STARTUP_UHD &&
    sourceDelivery(candidate) !== "unavailable"
  ) {
    return true;
  }

  // After first frame, never remount for a same-tier richer encode.
  if (everPlayed) return false;

  const betterMulti = isMultiRendition(candidate) && !isMultiRendition(current);
  const betterHeight =
    sourceMaxHeight(candidate) >
    sourceMaxHeight(current) + ROSTER_HEIGHT_UPGRADE_PX;
  const betterTransport = isFasterSource(current, candidate);
  const richerEncode = isMeaningfullyRicherSource(current, candidate);
  return betterMulti || betterHeight || betterTransport || richerEncode;
}

/**
 * Pure session policy. The player applies `next` when `replace` is true and
 * never re-sorts the roster itself.
 */
export function selectActiveSource(
  input: SelectActiveSourceInput
): SelectActiveSourceResult {
  const decideOptions: DecidePlaybackOptions = {
    preferredProvider: input.preferredProvider,
    preferredHeight: input.preferredHeight,
    fourKStartup: input.fourKStartup,
    contentClass: input.contentClass,
    failedIds: input.failedIds,
  };
  const decision = decidePlayback(input.roster, decideOptions);
  const best = decision.immediate;

  if (!input.roster.length) {
    return {
      next: null,
      deferredFourK: null,
      replace: Boolean(input.active),
      reason: "hold",
    };
  }

  if (input.active && input.urlRefreshPending) {
    const refreshed = input.roster.find((source) => source.id === input.active?.id);
    if (refreshed) {
      return {
        next: refreshed,
        deferredFourK: decision.deferredFourK,
        replace: true,
        reason: "url_refresh",
      };
    }
  }

  const stillValid =
    !!input.active && input.roster.some((source) => source.id === input.active?.id);
  const failed =
    input.failedIds instanceof Set
      ? input.failedIds
      : new Set(input.failedIds ?? []);
  const activeFailed = !!input.active && failed.has(input.active.id);

  if (stillValid && !activeFailed && input.active && best) {
    if (input.userPicked) {
      return {
        next: input.active,
        deferredFourK: decision.deferredFourK,
        replace: false,
        reason: "hold",
      };
    }
    if (best.id === input.active.id) {
      return {
        next: input.active,
        deferredFourK: decision.deferredFourK,
        replace: false,
        reason: "hold",
      };
    }
    const betterHeight =
      sourceMaxHeight(best) >
      sourceMaxHeight(input.active) + ROSTER_HEIGHT_UPGRADE_PX;
    const richerNative =
      sourceDelivery(best) === "direct" &&
      isMeaningfullyRicherSource(input.active, best);
    if (input.autoUpgraded && !betterHeight && !richerNative) {
      return {
        next: input.active,
        deferredFourK: decision.deferredFourK,
        replace: false,
        reason: "hold",
      };
    }
    if (
      !shouldAdoptRosterUpgrade({
        current: input.active,
        candidate: best,
        everPlayed: input.everPlayed,
        fourKStartup: input.fourKStartup,
        userPicked: input.userPicked,
        contentClass: input.contentClass,
        preferredHeight: input.preferredHeight,
      })
    ) {
      return {
        next: input.active,
        deferredFourK: decision.deferredFourK,
        replace: false,
        reason: "hold",
      };
    }
    return {
      next: best,
      deferredFourK: decision.deferredFourK,
      replace: true,
      reason: isLanguageRescueUpgrade(input.active, best, input.contentClass)
        ? "language_rescue"
        : "roster_upgrade",
    };
  }

  if ((!stillValid || (activeFailed && !input.userPicked)) && best) {
    return {
      next: best,
      deferredFourK: decision.deferredFourK,
      replace: !input.active || best.id !== input.active.id,
      reason: stillValid ? "failover" : "start",
    };
  }

  return {
    next: input.active,
    deferredFourK: decision.deferredFourK,
    replace: false,
    reason: "hold",
  };
}
