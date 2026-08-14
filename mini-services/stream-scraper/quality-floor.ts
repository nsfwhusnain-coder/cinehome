/**
 * Household picture-quality floor for the scraper roster.
 * Keep in sync with src/lib/playback/quality-floor.ts.
 */

export const QUALITY_FLOOR_HEIGHT = 720;

export const MIN_DECLARED_BITRATE_BPS: ReadonlyArray<readonly [number, number]> = [
  [2160, 10_000_000],
  [1080, 4_500_000],
  [720, 2_000_000],
  [0, 700_000],
];

const CAPTURE_PATTERN =
  /\b(?:hd[ ._-]?ts|hdcam|cam[ ._-]?rip|\bcam\b|tele[ ._-]?sync|tele[ ._-]?cine|hdtc|dvd[ ._-]?scr|screener)\b/i;

export interface QualityFloorFacts {
  url?: string;
  label?: string;
  provider?: string;
  maxHeight?: number;
  bitrateBps?: number;
}

export function minBitrateForHeight(height: number): number {
  return (
    MIN_DECLARED_BITRATE_BPS.find(([minimum]) => height >= minimum)?.[1] ??
    MIN_DECLARED_BITRATE_BPS.at(-1)![1]
  );
}

export function isCaptureQualityLabel(text: string): boolean {
  return CAPTURE_PATTERN.test(text || "");
}

export function isLeanDeclaredBitrate(
  height: number,
  bitrateBps?: number | null
): boolean {
  if (bitrateBps == null || bitrateBps <= 0) return false;
  if (height <= 0) return bitrateBps < minBitrateForHeight(0);
  return bitrateBps < minBitrateForHeight(height);
}

export function failsQualityFloor(source: QualityFloorFacts): boolean {
  const text = `${source.label ?? ""} ${source.provider ?? ""} ${source.url ?? ""}`;
  if (isCaptureQualityLabel(text)) return true;
  return isLeanDeclaredBitrate(source.maxHeight ?? 0, source.bitrateBps);
}

export function isSubHdSource(source: QualityFloorFacts): boolean {
  const height = source.maxHeight ?? 0;
  return height > 0 && height < QUALITY_FLOOR_HEIGHT;
}

export function filterHighQualitySources<T extends QualityFloorFacts>(
  sources: readonly T[]
): T[] {
  if (sources.length <= 1) return [...sources];
  let out = dropIfAnyRemain(sources, failsQualityFloor);
  const hasHd = out.some((source) => (source.maxHeight ?? 0) >= QUALITY_FLOOR_HEIGHT);
  if (hasHd) {
    out = dropIfAnyRemain(out, isSubHdSource);
  }
  return out;
}

function dropIfAnyRemain<T>(
  sources: readonly T[],
  reject: (source: T) => boolean
): T[] {
  const kept = sources.filter((source) => !reject(source));
  return kept.length ? kept : [...sources];
}
