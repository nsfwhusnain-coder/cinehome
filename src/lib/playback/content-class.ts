import { cachedFetch } from "@/lib/server-cache";
import { tmdb } from "@/lib/tmdb";
import {
  isTmdbAnimeTitle,
  keywordsFromTmdbAppend,
} from "@/lib/tmdb-anime";

export type PlaybackContentClass = "anime";

const ANIME_SIGNALS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cheap, cached TMDB details (keywords append only). Fail-open: a TMDB miss
 * must not block playback or invent a class.
 */
export async function resolvePlaybackContentClass(
  mediaType: "movie" | "tv",
  tmdbId: number
): Promise<PlaybackContentClass | undefined> {
  try {
    const details = await cachedFetch(
      `tmdb-anime-signals:${mediaType}:${tmdbId}`,
      () => tmdb.animeSignals(mediaType, tmdbId),
      ANIME_SIGNALS_TTL_MS
    );
    const isAnime = isTmdbAnimeTitle({
      genreIds: details.genre_ids,
      genres: details.genres,
      originalLanguage: details.original_language,
      originCountry: details.origin_country,
      productionCountries: details.production_countries,
      keywords: keywordsFromTmdbAppend(details.keywords),
    });
    return isAnime ? "anime" : undefined;
  } catch {
    return undefined;
  }
}
