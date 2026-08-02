/** Keep a little media before the requested position for a keyframe-safe seek. */
export const REMUX_SEEK_PREROLL_S = 6;

export function normalizeRemuxStart(
  logicalTargetSeconds: number,
  logicalDurationSeconds = 0,
  prerollSeconds = REMUX_SEEK_PREROLL_S
): number {
  if (!Number.isFinite(logicalTargetSeconds) || logicalTargetSeconds <= 0) return 0;
  const upperBound =
    Number.isFinite(logicalDurationSeconds) && logicalDurationSeconds > 1
      ? logicalDurationSeconds - 1
      : Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.min(upperBound, Math.floor(logicalTargetSeconds - Math.max(0, prerollSeconds)))
  );
}

export function toLogicalTime(mediaSeconds: number, remuxStartSeconds: number): number {
  return Math.max(0, mediaSeconds) + Math.max(0, remuxStartSeconds);
}

export function toMediaTime(logicalSeconds: number, remuxStartSeconds: number): number {
  return Math.max(0, logicalSeconds - Math.max(0, remuxStartSeconds));
}

export function logicalDuration(
  mediaDurationSeconds: number,
  remuxStartSeconds: number,
  expectedDurationSeconds = 0,
  provisional = false
): number {
  if (provisional && Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0) {
    return expectedDurationSeconds;
  }
  if (!Number.isFinite(mediaDurationSeconds) || mediaDurationSeconds <= 0) return 0;
  return toLogicalTime(mediaDurationSeconds, remuxStartSeconds);
}

export function isLogicalTimeSeekable(
  ranges: TimeRanges,
  logicalSeconds: number,
  remuxStartSeconds: number,
  toleranceSeconds = 0.5
): boolean {
  const mediaSeconds = toMediaTime(logicalSeconds, remuxStartSeconds);
  for (let index = 0; index < ranges.length; index += 1) {
    if (
      mediaSeconds >= ranges.start(index) - toleranceSeconds &&
      mediaSeconds <= ranges.end(index) + toleranceSeconds
    ) {
      return true;
    }
  }
  return false;
}
