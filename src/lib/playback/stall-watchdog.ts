/**
 * Pure decision logic for the engine-agnostic playhead watchdog.
 *
 * The watchdog is the only thing that can declare a *playing* source dead, so
 * its two judgements are worth isolating and testing directly:
 *
 *  1. Is the stream still alive? A frozen `currentTime` is not proof of death —
 *     a stream whose BUFFER is still filling is downloading a cold region,
 *     which is exactly what a long seek into a high-bitrate 4K stream looks
 *     like. Treating that as a hang is what removed healthy 4K sources from the
 *     roster after skipping ahead.
 *
 *  2. How long to wait before calling it. Steady-state playback and the moments
 *     right after a seek are different regimes: a seek discards the buffer and
 *     must refetch from a cold position, and a 4K segment (~10 MB per 6s) on a
 *     cold CDN edge routinely needs far longer than the mid-watch threshold.
 */

/** Playhead/buffer movement (seconds) that counts as real progress. */
export const STALL_MIN_ADVANCE_S = 0.34;

export interface StallProgressInput {
  /** Playhead and buffer end at the start of the current window. */
  baselinePositionS: number;
  baselineBufferedEndS: number;
  /** Playhead and buffer end right now. */
  positionS: number;
  bufferedEndS: number;
}

/**
 * True when the stream advanced the playhead OR pulled more data since the
 * baseline. Either one means the source is working.
 */
export function hasStreamProgress(input: StallProgressInput): boolean {
  const played = input.positionS - input.baselinePositionS;
  if (played > STALL_MIN_ADVANCE_S) return true;
  const buffered = input.bufferedEndS - input.baselineBufferedEndS;
  return buffered > STALL_MIN_ADVANCE_S;
}

export interface StallThresholdInput {
  /** Steady-state threshold for the active engine. */
  baseThresholdMs: number;
  /** Threshold to use while still inside the post-seek window. */
  postSeekThresholdMs: number;
  /** How long the post-seek window lasts. */
  postSeekGraceMs: number;
  /** Milliseconds since the last seek started. */
  sinceSeekMs: number;
}

/**
 * The no-progress window this tick must exceed before the source can be failed.
 * Never shortens the engine's own threshold — only extends it after a seek.
 */
export function stallThresholdMs(input: StallThresholdInput): number {
  if (input.sinceSeekMs >= input.postSeekGraceMs) return input.baseThresholdMs;
  return Math.max(input.baseThresholdMs, input.postSeekThresholdMs);
}
