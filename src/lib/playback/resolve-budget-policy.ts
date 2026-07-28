import type { PlaybackRefreshMode } from "./refresh-mode";

export type PlaybackResolveCacheState = "HIT" | "MISS" | "BYPASS";

/**
 * Decide whether this request represents an expensive live resolve.
 *
 * Forced refreshes are charged at the pre-cache BYPASS stage. Ordinary full
 * requests are charged only after a MISS. Fast/prefetch and warm cache hits
 * never consume the expensive resolve budget.
 */
export function shouldConsumePlaybackResolveBudget(input: {
  fast: boolean;
  refreshMode: PlaybackRefreshMode;
  cache: PlaybackResolveCacheState;
}): boolean {
  if (input.fast) return false;
  if (input.refreshMode !== "none") return input.cache === "BYPASS";
  return input.cache === "MISS";
}
