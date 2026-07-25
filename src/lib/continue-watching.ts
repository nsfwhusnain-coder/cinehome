/**
 * Continue Watching: one card per title.
 * TV shows collapse to the most recently updated episode (resume point).
 */

export interface ContinueProgressLike {
  tmdbId: number;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
}

/**
 * Keep movies as-is. For TV, keep only the latest-left episode per show
 * (first occurrence when items are already newest-first by updatedAt).
 */
export function collapseContinueItems<T extends ContinueProgressLike>(items: T[]): T[] {
  if (!items.length) return [];
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of items) {
    const mediaType = (item.mediaType || "movie").toLowerCase();
    const key =
      mediaType === "tv"
        ? `tv:${item.tmdbId}`
        : `movie:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}
