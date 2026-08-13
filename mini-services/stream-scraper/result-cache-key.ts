const MIN_QUALITY_HEIGHT = 1080;
const MAX_QUALITY_HEIGHT = 4320;

export function normalizeQualityHeight(height: number): number {
  if (!Number.isFinite(height) || height < MIN_QUALITY_HEIGHT) {
    return MIN_QUALITY_HEIGHT;
  }
  return Math.min(Math.round(height), MAX_QUALITY_HEIGHT);
}

export function resultCacheKey(
  tmdbId: number,
  mediaType: string,
  season: number | undefined,
  episode: number | undefined,
  qualityHeight: number,
  fast: boolean
): string {
  const pass = fast ? "fast" : "full";
  return `${mediaType}:${tmdbId}:${season ?? ""}:${episode ?? ""}:q${normalizeQualityHeight(qualityHeight)}:${pass}`;
}
