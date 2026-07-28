export const PROGRESSIVE_POLL_INTERVAL_BASE_MS = 2_000;
export const PROGRESSIVE_POLL_INTERVAL_LATER_MS = 5_000;
export const PROGRESSIVE_POLL_MAX_REFETCHES = 5;
export const PROGRESSIVE_POLL_AGGRESSIVE_UNTIL = 3;
export const PROGRESSIVE_POLL_TARGET = 4;
export const PROGRESSIVE_POLL_WALL_MS = 30_000;

export interface ProgressivePollState {
  rateLimited: boolean;
  hasAuthoritativeData: boolean;
  fetching: boolean;
  partial: boolean;
  usableSourceCount: number;
  extraFetches: number;
  elapsedMs: number;
}

/**
 * Poll only while the server explicitly says discovery is incomplete.
 *
 * A complete one-source response is authoritative: repeatedly resolving it
 * cannot discover more servers and only burns the per-title request budget.
 */
export function progressivePollInterval(
  state: ProgressivePollState
): number | false {
  if (state.rateLimited || !state.hasAuthoritativeData || state.fetching) {
    return false;
  }
  if (!state.partial || state.usableSourceCount >= PROGRESSIVE_POLL_TARGET) {
    return false;
  }
  if (
    state.extraFetches >= PROGRESSIVE_POLL_MAX_REFETCHES ||
    state.elapsedMs >= PROGRESSIVE_POLL_WALL_MS
  ) {
    return false;
  }
  if (
    state.usableSourceCount < PROGRESSIVE_POLL_AGGRESSIVE_UNTIL &&
    state.extraFetches < 3
  ) {
    return PROGRESSIVE_POLL_INTERVAL_BASE_MS;
  }
  return PROGRESSIVE_POLL_INTERVAL_LATER_MS;
}
