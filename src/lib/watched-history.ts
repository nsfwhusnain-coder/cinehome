/**
 * Client-side "Already watched" list — marked from My List (tick).
 * Stored in localStorage so no schema migration is required.
 */

export interface WatchedHistoryItem {
  tmdbId: number;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null;
  markedAt: number;
}

const WATCHED_KEY = "cinehome:watched";
const MAX_WATCHED = 200;

export function loadWatchedHistory(): WatchedHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is WatchedHistoryItem =>
          !!x &&
          typeof x === "object" &&
          typeof (x as WatchedHistoryItem).tmdbId === "number" &&
          typeof (x as WatchedHistoryItem).mediaType === "string" &&
          typeof (x as WatchedHistoryItem).title === "string"
      )
      .slice(0, MAX_WATCHED);
  } catch {
    return [];
  }
}

function saveWatchedHistory(items: WatchedHistoryItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify(items.slice(0, MAX_WATCHED)));
  } catch {
    /* ignore quota */
  }
}

export function markAsWatched(
  item: Omit<WatchedHistoryItem, "markedAt">
): WatchedHistoryItem[] {
  const list = loadWatchedHistory().filter(
    (x) => !(x.tmdbId === item.tmdbId && x.mediaType === item.mediaType)
  );
  list.unshift({ ...item, markedAt: Date.now() });
  saveWatchedHistory(list);
  return list;
}

export function removeFromWatched(
  tmdbId: number,
  mediaType: string
): WatchedHistoryItem[] {
  const list = loadWatchedHistory().filter(
    (x) => !(x.tmdbId === tmdbId && x.mediaType === mediaType)
  );
  saveWatchedHistory(list);
  return list;
}

export function clearWatchedHistory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(WATCHED_KEY);
  } catch {
    /* ignore */
  }
}
