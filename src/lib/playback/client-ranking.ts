import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  decidePlayback,
  type PlaybackDecision,
} from "./decide-playback";
import {
  isLanguageRescueUpgrade,
  shouldAdoptRosterUpgrade,
  ROSTER_HEIGHT_UPGRADE_PX,
} from "./select-active-source";

export { isLanguageRescueUpgrade, shouldAdoptRosterUpgrade, ROSTER_HEIGHT_UPGRADE_PX };

export type StartupSourceDecision = PlaybackDecision;

export interface RosterUpgradeDecision {
  current: PlaybackSource;
  candidate: PlaybackSource;
  everPlayed: boolean;
  fourKStartup: FourKStartupPreference;
  userPicked: boolean;
}

/**
 * Back-compat wrapper. New call sites should use `decidePlayback`.
 */
export function pickClientStartupSource(
  sources: readonly PlaybackSource[],
  options: {
    preferredProvider?: string | null;
    preferredHeight?: "auto" | number | null;
    fourKStartup: FourKStartupPreference;
    contentClass?: string | null;
    failedIds?: ReadonlySet<string> | readonly string[];
  }
): StartupSourceDecision {
  return decidePlayback(sources, options);
}
