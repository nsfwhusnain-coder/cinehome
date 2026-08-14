const MIN_QUALITY_HEIGHT = 1080;
const MAX_QUALITY_HEIGHT = 4320;

export function normalizeQualityHeight(height: number): number {
  if (!Number.isFinite(height) || height < MIN_QUALITY_HEIGHT) {
    return MIN_QUALITY_HEIGHT;
  }
  return Math.min(Math.round(height), MAX_QUALITY_HEIGHT);
}

/**
 * `contentClass=anime` (any mediaType) or TV `anime=1` query flag.
 * Ranking is not request-local-only — default streamUrl changes — so the
 * class is part of the result cache key.
 */
export function parseContentClassParam(
  contentClassRaw: string | null | undefined,
  animeFlagRaw: string | null | undefined,
  mediaType: string
): "anime" | undefined {
  const klass = (contentClassRaw ?? "").trim().toLowerCase();
  if (klass === "anime") return "anime";
  const flag = (animeFlagRaw ?? "").trim().toLowerCase();
  if (
    mediaType === "tv" &&
    (flag === "1" || flag === "true" || flag === "yes" || flag === "anime")
  ) {
    return "anime";
  }
  return undefined;
}

export function resultCacheKey(
  tmdbId: number,
  mediaType: string,
  season: number | undefined,
  episode: number | undefined,
  qualityHeight: number,
  fast: boolean,
  contentClass?: string
): string {
  const pass = fast ? "fast" : "full";
  const klass = contentClass === "anime" ? "anime" : "";
  const klassPart = klass ? `:${klass}` : "";
  return `${mediaType}:${tmdbId}:${season ?? ""}:${episode ?? ""}:q${normalizeQualityHeight(qualityHeight)}${klassPart}:${pass}`;
}
