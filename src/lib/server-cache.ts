/**
 * In-memory stale-while-revalidate cache for catalog / metadata.
 * Process-local (one Node/Bun instance). TTL ~6h with background revalidate.
 */

type Entry<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
  revalidating?: Promise<T>;
};

const store = new Map<string, Entry<unknown>>();

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_GRACE_MS = 30 * 60 * 1000;

export async function cachedFetch<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  if (hit && now < hit.freshUntil) {
    return hit.value;
  }

  if (hit && now < hit.staleUntil) {
    if (!hit.revalidating) {
      hit.revalidating = loader()
        .then((value) => {
          store.set(key, {
            value,
            freshUntil: Date.now() + ttlMs,
            staleUntil: Date.now() + ttlMs + STALE_GRACE_MS,
          });
          return value;
        })
        .catch(() => hit.value)
        .finally(() => {
          const cur = store.get(key) as Entry<T> | undefined;
          if (cur) cur.revalidating = undefined;
        });
    }
    return hit.value;
  }

  const value = await loader();
  store.set(key, {
    value,
    freshUntil: now + ttlMs,
    staleUntil: now + ttlMs + STALE_GRACE_MS,
  });
  return value;
}

/**
 * Per-user playback response cache (proxy URLs embed HLS session ids).
 * Complete resolves: 3m warm. Partial: short so progressive poll can advance.
 */
const playbackStore = new Map<string, { value: unknown; until: number }>();
/** Match the 3m scraper TTL so expired signed links are never kept for 20m. */
export const PLAYBACK_TTL_MS = 3 * 60 * 1000;
/** Below the client's 2s poll interval so progressive results can actually advance. */
export const PLAYBACK_PARTIAL_TTL_MS = 1_500;

export function getCachedPlayback<T>(key: string): T | null {
  const hit = playbackStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    playbackStore.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setCachedPlayback(key: string, value: unknown, ttlMs = PLAYBACK_TTL_MS): void {
  playbackStore.set(key, { value, until: Date.now() + ttlMs });
}

/**
 * Playback responses embed per-user HLS session IDs in proxy URLs.
 * Cache key MUST include userId or user B gets user A's sessions → HTTP 403 Forbidden
 * on every /api/hls request (breaks Opera/Chrome/etc. identically).
 *
 * Cross-user warm for *public* stream lists lives in `rawScrapeCacheKey` —
 * shared scrape payload, then per-user session mint in playback/scraper.ts.
 */
export function playbackCacheKey(
  mediaType: string,
  tmdbId: number,
  season: number | undefined,
  episode: number | undefined,
  fast: boolean | undefined,
  userId: string,
  qualityPreference: "auto" | number = "auto"
): string {
  return `pb:${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}:${fast ? "f" : "full"}:q${qualityPreference}`;
}

/**
 * Raw (pre-session-mint) scraper result cache — deliberately cross-user.
 * The scrape itself is identical for every user on the same title/S/E/pass;
 * only HLS session + proxy URLs minted after are user-scoped.
 */
const rawScrapeStore = new Map<string, { value: unknown; until: number }>();
/** Raw signed provider links follow the scraper's short-lived source cache. */
export const RAW_SCRAPE_TTL_MS = 3 * 60 * 1000;
export const RAW_SCRAPE_PARTIAL_TTL_MS = 1_500;

export function rawScrapeCacheKey(
  mediaType: string,
  tmdbId: number,
  season: number | undefined,
  episode: number | undefined,
  fast: boolean | undefined
): string {
  return `raw:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}:${fast ? "f" : "full"}`;
}

export function getCachedRawScrape<T>(key: string): T | null {
  const hit = rawScrapeStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    rawScrapeStore.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setCachedRawScrape(key: string, value: unknown, ttlMs = RAW_SCRAPE_TTL_MS): void {
  rawScrapeStore.set(key, { value, until: Date.now() + ttlMs });
}
