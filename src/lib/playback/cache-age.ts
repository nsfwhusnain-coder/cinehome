import type { PlaybackResponse } from "./types";

const COMPLETE_SOURCE_MAX_AGE_MS = 2 * 60 * 1000;

/** Never surface a signed/session URL beyond the cache tier that produced it. */
export function usableCachedPlayback(
  data: PlaybackResponse | undefined,
  updatedAt: number,
  now = Date.now()
): PlaybackResponse | undefined {
  if (!data || updatedAt <= 0 || updatedAt > now) return undefined;
  return now - updatedAt <= COMPLETE_SOURCE_MAX_AGE_MS ? data : undefined;
}
