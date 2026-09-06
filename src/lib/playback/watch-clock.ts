/**
 * Accumulates time a source was *actually rendering video*.
 *
 * A first frame proves a stream opened. Only sustained playback proves it was
 * watchable — a corrupt file, a trailer mislabelled as the feature, or the
 * wrong title entirely all render a first frame just as convincingly. This is
 * the evidence `source-memory.ts` uses to separate those cases, so it must
 * count only genuine playback: paused, buffering, stalled and seeking time all
 * stop the clock, or an abandoned tab would look like a two-hour viewing.
 */

/** Ignore a single tick longer than this — a slept laptop, not viewing time. */
export const MAX_TICK_MS = 5 * 60 * 1000;

export interface WatchClock {
  sourceId: string | null;
  accumulatedMs: number;
  runningSince: number | null;
}

export interface FlushedWatch {
  sourceId: string;
  watchedMs: number;
}

export function createWatchClock(): WatchClock {
  return { sourceId: null, accumulatedMs: 0, runningSince: null };
}

function settle(clock: WatchClock, now: number): number {
  if (clock.runningSince === null) return clock.accumulatedMs;
  const tick = Math.max(0, now - clock.runningSince);
  return clock.accumulatedMs + Math.min(tick, MAX_TICK_MS);
}

/** Total watched time including any tick currently in flight. */
export function watchedMs(clock: WatchClock, now: number): number {
  return Math.round(settle(clock, now));
}

/** Video began or resumed rendering. Idempotent while already running. */
export function startWatching(
  clock: WatchClock,
  sourceId: string,
  now: number
): WatchClock {
  if (clock.sourceId === sourceId && clock.runningSince !== null) return clock;
  if (clock.sourceId !== sourceId) {
    return { sourceId, accumulatedMs: 0, runningSince: now };
  }
  return { ...clock, runningSince: now };
}

/** Paused, buffering, stalled or seeking — anything that is not rendering. */
export function stopWatching(clock: WatchClock, now: number): WatchClock {
  if (clock.runningSince === null) return clock;
  return { ...clock, accumulatedMs: settle(clock, now), runningSince: null };
}

/**
 * Close out the current source and hand back what it earned, ready to report.
 * Returns `null` when there is nothing worth reporting, so callers can emit
 * unconditionally without filtering.
 */
export function flushWatch(
  clock: WatchClock,
  now: number
): { flushed: FlushedWatch | null; next: WatchClock } {
  const total = watchedMs(clock, now);
  const flushed =
    clock.sourceId && total > 0
      ? { sourceId: clock.sourceId, watchedMs: total }
      : null;
  return { flushed, next: createWatchClock() };
}
