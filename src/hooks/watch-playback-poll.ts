/** Early polls while the first full roster is still empty. */
export const POLL_INTERVAL_BASE_MS = 2_000;
/** Back off once hunting has a few cycles, or while waiting on preferred 4K. */
export const POLL_INTERVAL_LATER_MS = 5_000;
/** Cap empty-roster hunting (was 12, then 5). */
export const MAX_SOURCE_POLL_REFETCHES = 5;
/** Aggressive 2s polls only while below this empty-hunt count. */
export const SOURCE_POLL_AGGRESSIVE_UNTIL = 3;
/** Wall-clock budget for empty-roster hunting / preferred-quality follow-up. */
export const POLL_WALL_MS = 45_000;
/** Extra full fetches after HD exists while still hunting the Ultra 4K source. */
export const PREFERRED_QUALITY_POLL_MAX = 4;
/**
 * Below this many usable sources a roster is treated as still-forming, so the
 * poll keeps hunting even though something is already playable.
 *
 * Mirrors the scraper's PARTIAL_CLEAR_MIN. A cold resolve lands at 1-3 sources
 * and background enrichment takes the same title to 14-20 within a minute;
 * without this the poll stopped at the first playable row and the viewer kept
 * the thin roster (often a single server, no quality choice) for the whole
 * session. Still bounded by PREFERRED_QUALITY_POLL_MAX and POLL_WALL_MS.
 */
export const SOURCE_POLL_HEALTHY_MIN = 5;

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
  /** Server still reports the roster as forming (scraper `partial`). */
  rosterPartial: boolean;
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

  // Something plays, but the server says the roster is still forming and it is
  // still thin — keep hunting so background enrichment reaches this session.
  const rosterStillForming =
    input.rosterPartial && input.playableCount < SOURCE_POLL_HEALTHY_MIN;

  if (
    input.playableCount >= 1 &&
    !input.preferredQualityPending &&
    !rosterStillForming
  ) {
    return false;
  }

  if (input.elapsedMs >= POLL_WALL_MS) return false;

  if (
    input.playableCount >= 1 &&
    (input.preferredQualityPending || rosterStillForming)
  ) {
    if (input.extraFetches >= PREFERRED_QUALITY_POLL_MAX) return false;
    return POLL_INTERVAL_LATER_MS;
  }

  if (input.extraFetches >= MAX_SOURCE_POLL_REFETCHES) return false;
  if (input.playableCount < SOURCE_POLL_AGGRESSIVE_UNTIL && input.extraFetches < 3) {
    return POLL_INTERVAL_BASE_MS;
  }
  return POLL_INTERVAL_LATER_MS;
}
