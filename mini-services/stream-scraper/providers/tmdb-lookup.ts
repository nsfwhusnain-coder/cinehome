import type { TmdbLookup } from "./types";

const TMDB_KEY = process.env.TMDB_API_KEY || "";
const LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000;

interface LookupCacheEntry {
  expiresAt: number;
  value: TmdbLookup | null;
}

const lookupCache = new Map<string, LookupCacheEntry>();
const lookupInFlight = new Map<string, Promise<TmdbLookup | null>>();

async function fetchTmdbLookup(
  tmdbId: number,
  mediaType: "movie" | "tv"
): Promise<TmdbLookup | null> {
  if (!TMDB_KEY) return null;
  const type = mediaType === "tv" ? "tv" : "movie";
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=external_ids`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      name?: string;
      release_date?: string;
      first_air_date?: string;
      external_ids?: { imdb_id?: string };
      runtime?: number | null;
      episode_run_time?: number[];
    };
    const title = data.title || data.name || "";
    const year = (data.release_date || data.first_air_date || "").split("-")[0];
    const imdbId = data.external_ids?.imdb_id || "";
    if (!title) return null;
    const runtimeMinutes =
      type === "movie" ? data.runtime : data.episode_run_time?.[0];
    const runtimeSeconds =
      typeof runtimeMinutes === "number" && runtimeMinutes > 0
        ? runtimeMinutes * 60
        : 0;
    return { title, year, imdbId, type, runtimeSeconds };
  } catch {
    return null;
  }
}

export function lookupTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv"
): Promise<TmdbLookup | null> {
  const key = `${mediaType}:${tmdbId}`;
  const cached = lookupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.value);
  }
  if (cached) lookupCache.delete(key);

  const existing = lookupInFlight.get(key);
  if (existing) return existing;

  const request = fetchTmdbLookup(tmdbId, mediaType)
    .then((value) => {
      lookupCache.set(key, {
        value,
        expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
      });
      return value;
    })
    .finally(() => lookupInFlight.delete(key));
  lookupInFlight.set(key, request);
  return request;
}
