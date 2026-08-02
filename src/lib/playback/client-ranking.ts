import type { FourKStartupPreference } from "@/lib/profile-preferences";
import type { PlaybackSource } from "./types";
import {
  HD_FLOOR_HEIGHT,
  pickDefaultSource,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";

export interface StartupSourceDecision {
  immediate: PlaybackSource | null;
  /** A cold 4K remux worth preparing without delaying the first frame. */
  deferredFourK: PlaybackSource | null;
  reason: "ranked_best" | "fast_start_direct_hd" | "no_source";
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
  const best = pickDefaultSource(
    roster,
    options.preferredProvider,
    options.preferredHeight
  );
  if (!best) {
    return { immediate: null, deferredFourK: null, reason: "no_source" };
  }
  if (
    options.fourKStartup === "maximum" ||
    sourceDelivery(best) !== "remux" ||
    sourceMaxHeight(best) < 2160
  ) {
    return { immediate: best, deferredFourK: null, reason: "ranked_best" };
  }

  const directHd = roster.filter(
    (source) =>
      sourceDelivery(source) === "direct" &&
      sourceMaxHeight(source) >= HD_FLOOR_HEIGHT
  );
  const immediate = pickDefaultSource(
    directHd,
    options.preferredProvider,
    Math.min(
      typeof options.preferredHeight === "number"
        ? options.preferredHeight
        : HD_FLOOR_HEIGHT,
      HD_FLOOR_HEIGHT
    )
  );
  if (!immediate) {
    return { immediate: best, deferredFourK: null, reason: "ranked_best" };
  }
  return {
    immediate,
    deferredFourK: best,
    reason: "fast_start_direct_hd",
  };
}
