/** Early polls while the first full roster is still empty. */
export const POLL_INTERVAL_BASE_MS = 2_000;
/** Back off once hunting has a few cycles, or while waiting on preferred 4K. */
export const POLL_INTERVAL_LATER_MS = 5_000;
/** Cap empty-roster hunting (was 12, then 5). */
export const MAX_SOURCE_POLL_REFETCHES = 5;
/** Aggressive 2s polls only while below this empty-hunt count. */
export const SOURCE_POLL_AGGRESSIVE_UNTIL = 3;
/** Wall-clock budget for empty-roster hunting / preferred-quality follow-up. */
export const POLL_WALL_MS = 30_000;
/** At most this many extra full fetches after we already have something playable. */
export const PREFERRED_QUALITY_POLL_MAX = 2;

export function playbackPollRefetchCount(
  dataUpdateCount: number,
  baselineUpdates: number
): number {
  const completedSinceMount = dataUpdateCount - baselineUpdates;
  const initialFetchOffset = baselineUpdates === 0 ? 1 : 0;
  return Math.max(0, completedSinceMount - initialFetchOffset);
}

export interface WatchPlaybackPollInput {
  rateLimited: boolean;
  hasFullData: boolean;
  fetching: boolean;
  playableCount: number;
  preferredQualityPending: boolean;
  extraFetches: number;
  elapsedMs: number;
}

/**
 * Progressive full-path polling.
 *
 * One playable source is enough to stop hunting. Partial flags and thin
 * rosters used to keep refetching every 2s; the playback cache's 1.5s partial
 * TTL then forced a fresh scrape + debrid resolve on every tick.
 *
 * Empty rosters may still hunt inside the wall/budget. Preferred 4K may take
 * two slow follow-ups after a playable HD source exists.
 */
export function watchPlaybackPollInterval(
  input: WatchPlaybackPollInput
): number | false {
  if (input.rateLimited) return false;
  if (!input.hasFullData || input.fetching) return false;

  if (input.playableCount >= 1 && !input.preferredQualityPending) {
    return false;
  }

  if (input.elapsedMs >= POLL_WALL_MS) return false;

  if (input.playableCount >= 1 && input.preferredQualityPending) {
    if (input.extraFetches >= PREFERRED_QUALITY_POLL_MAX) return false;
    return POLL_INTERVAL_LATER_MS;
  }

  if (input.extraFetches >= MAX_SOURCE_POLL_REFETCHES) return false;
  if (input.playableCount < SOURCE_POLL_AGGRESSIVE_UNTIL && input.extraFetches < 3) {
    return POLL_INTERVAL_BASE_MS;
  }
  return POLL_INTERVAL_LATER_MS;
}
