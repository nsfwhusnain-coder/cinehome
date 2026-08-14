export type CachedProvider = "realdebrid" | "torbox";

/** Bump when RD roster ranking changes so old winners cannot survive the TTL. */
export const REAL_DEBRID_CACHE_POLICY = "rich-v2";

export function storedQualityForCache(
  provider: CachedProvider,
  quality: string
): string {
  return provider === "realdebrid"
    ? `${REAL_DEBRID_CACHE_POLICY}:${quality}`
    : quality;
}
