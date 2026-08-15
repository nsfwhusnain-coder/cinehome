/**
 * TMDB API client — server-side only (hides API key).
 * Docs: https://developer.themoviedb.org/reference/intro/getting-started
 */

import { db } from "@/lib/db";

const TMDB_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export type TmdbImageSize =
  | "w92"
  | "w185"
  | "w200"
  | "w300"
  | "w342"
  | "w500"
  | "w780"
  | "w1280"
  | "original";

export function tmdbImageUrl(path: string | null | undefined, size: TmdbImageSize = "w500") {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

export interface ResponsiveTmdbImage {
  src: string;
  srcSet: string;
  sizes: string;
}

/**
 * Full-resolution poster. Quality first — never a downsized TMDB rung.
 */
export function posterSrcSet(path: string | null | undefined): ResponsiveTmdbImage | null {
  if (!path) return null;
  const original = tmdbImageUrl(path, "original");
  if (!original) return null;
  return {
    src: original,
    srcSet: original,
    sizes: "100vw",
  };
}

/**
 * Full-resolution backdrop. Quality first — never a downsized TMDB rung.
 */
export function backdropSrcSet(path: string | null | undefined): ResponsiveTmdbImage | null {
  if (!path) return null;
  const original = tmdbImageUrl(path, "original");
  if (!original) return null;
  return {
    src: original,
    srcSet: original,
    sizes: "100vw",
  };
}

/** Pick the best title-logo asset from a TMDB images response: English first, then language-agnostic, then whatever's first. */
export function pickTitleLogoUrl(
  images: TmdbImages | null | undefined,
  size: "w300" | "w500" | "original" = "original"
): string | null {
  if (!images?.logos?.length) return null;
  const english = images.logos.find((l) => l.iso_639_1 === "en");
  const languageless = images.logos.find((l) => l.iso_639_1 === null);
  const logo = english || languageless || images.logos[0];
  return `${TMDB_IMAGE_BASE}/${size}${logo.file_path}`;
}

async function apiKey(): Promise<string> {
  const setting = await db.appSetting.findUnique({ where: { key: "tmdb_api_key" } });
  const key = setting?.value || process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY is not set");
  return key;
}

async function tmdbFetch<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", await apiKey());
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 3600 }, // cache for an hour
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ---------- Types ----------
export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  runtime?: number;
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
  imdb_id?: string | null;
  budget?: number;
  revenue?: number;
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  adult?: boolean;
}

export interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: { id: number; name: string }[];
  status?: string;
  seasons?: TmdbSeason[];
  created_by?: { id: number; name: string; profile_path: string | null }[];
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  adult?: boolean;
}

export interface TmdbSeason {
  id: number;
  season_number: number;
  episode_count: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
  vote_average: number;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path: string | null;
}

export interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface TmdbPaged<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface TmdbWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
  display_priority: number;
}

export interface TmdbWatchProviderRegion {
  link: string;
  flatrate?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
}

export interface TmdbReview {
  id: string;
  author: string;
  content: string;
  created_at: string;
  author_details: { rating: number | null };
}

export interface TmdbImage {
  file_path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  iso_639_1: string | null;
}

export interface TmdbImages {
  backdrops: TmdbImage[];
  posters: TmdbImage[];
  logos: TmdbImage[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  profile_path: string | null;
  known_for_department: string;
  also_known_as?: string[];
  popularity?: number;
  gender?: number;
  adult?: boolean;
}

export interface TmdbPersonCredit {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number;
  popularity?: number;
  media_type?: string;
  character?: string;
  job?: string;
  department?: string;
  adult?: boolean;
}

export interface TmdbPersonCredits {
  id: number;
  cast: TmdbPersonCredit[];
  crew: TmdbPersonCredit[];
}

export interface TmdbAnimeSignalsRaw {
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string; name?: string }[];
  keywords?: {
    keywords?: { id: number; name: string }[];
    results?: { id: number; name: string }[];
  };
}

export { withoutAdultTitles } from "./tmdb-filters";

// ---------- Endpoints ----------
export const tmdb = {
  trending: (window: "day" | "week" = "week") =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/trending/movie/${window}`),

  trendingTv: (window: "day" | "week" = "week") =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/trending/tv/${window}`),

  popularMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/popular`, { page }),

  topRatedMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/top_rated`, { page }),

  upcomingMovies: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/upcoming`, { page }),

  nowPlaying: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie>>(`/movie/now_playing`, { page }),

  popularTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/popular`, { page }),

  topRatedTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/top_rated`, { page }),

  airingTodayTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/airing_today`, { page }),

  onTheAirTv: (page = 1) =>
    tmdbFetch<TmdbPaged<TmdbTv>>(`/tv/on_the_air`, { page }),

  movieDetails: (id: number) =>
    tmdbFetch<
      TmdbMovie & {
        credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
        videos?: { results: TmdbVideo[] };
        recommendations?: TmdbPaged<TmdbMovie>;
        similar?: TmdbPaged<TmdbMovie>;
        reviews?: TmdbPaged<TmdbReview>;
        "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
      }
    >(`/movie/${id}`, {
      append_to_response:
        "credits,videos,recommendations,similar,reviews,watch/providers,release_dates",
    }),

  movieImages: (id: number) =>
    tmdbFetch<TmdbImages>(`/movie/${id}/images`, { include_image_language: "en,null" }),

  tvImages: (id: number) =>
    tmdbFetch<TmdbImages>(`/tv/${id}/images`, { include_image_language: "en,null" }),

  tvDetails: (id: number) =>
    tmdbFetch<
      TmdbTv & {
        credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
        videos?: { results: TmdbVideo[] };
        recommendations?: TmdbPaged<TmdbTv>;
        similar?: TmdbPaged<TmdbTv>;
        reviews?: TmdbPaged<TmdbReview>;
        "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
      }
    >(`/tv/${id}`, {
      append_to_response:
        "credits,videos,recommendations,similar,reviews,watch/providers,content_ratings",
    }),

  /**
   * Light details + keywords only. Used by playback to decide contentClass=anime
   * without paying for the full movieDetails/tvDetails append set.
   */
  animeSignals: (type: "movie" | "tv", id: number) =>
    tmdbFetch<TmdbAnimeSignalsRaw>(`/${type}/${id}`, {
      append_to_response: "keywords",
    }),

  watchProviders: (id: number, type: "movie" | "tv") =>
    tmdbFetch<{ results: Record<string, TmdbWatchProviderRegion> }>(`/${type}/${id}/watch/providers`),

  /** IMDb id lookup — Torrentio (debrid tier) is keyed by imdb id, not tmdb id. */
  externalIds: (id: number, type: "movie" | "tv") =>
    tmdbFetch<{ id: number; imdb_id: string | null }>(`/${type}/${id}/external_ids`),

  tvSeason: (id: number, season: number) =>
    tmdbFetch<{ episodes: TmdbEpisode[]; name: string; overview: string; season_number: number }>(
      `/tv/${id}/season/${season}`
    ),

  search: (query: string, page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie & { media_type?: string }>>(`/search/movie`, { query, page, include_adult: false }),

  searchMulti: (query: string, page = 1) =>
    tmdbFetch<TmdbPaged<(TmdbMovie | TmdbTv) & { media_type: string }>>(`/search/multi`, { query, page, include_adult: false }),

  genres: (type: "movie" | "tv" = "movie") =>
    tmdbFetch<{ genres: { id: number; name: string }[] }>(`/genre/${type}/list`),

  discoverByGenre: (type: "movie" | "tv", genreId: number, page = 1) =>
    tmdbFetch<TmdbPaged<TmdbMovie | TmdbTv>>(`/discover/${type}`, {
      with_genres: genreId,
      page,
      sort_by: "popularity.desc",
      include_adult: false,
    }),

  /** Discover titles available on a streaming provider (e.g. Netflix = 8). */
  discoverByWatchProvider: (
    type: "movie" | "tv",
    providerId: number,
    page = 1,
    region = "US"
  ) =>
    tmdbFetch<TmdbPaged<TmdbMovie | TmdbTv>>(`/discover/${type}`, {
      with_watch_providers: providerId,
      watch_region: region,
      page,
      sort_by: "popularity.desc",
      include_adult: false,
    }),

  personDetails: (id: number) => tmdbFetch<TmdbPerson>(`/person/${id}`),

  personCredits: (id: number) =>
    tmdbFetch<TmdbPersonCredits>(`/person/${id}/combined_credits`),
};

/** TMDB watch provider id for Netflix (US catalog). */
export const NETFLIX_PROVIDER_ID = 8;

export const COMMON_GENRES: { id: number; name: string }[] = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 14, name: "Fantasy" },
  { id: 36, name: "History" },
  { id: 27, name: "Horror" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Science Fiction" },
  { id: 53, name: "Thriller" },
  { id: 10752, name: "War" },
  { id: 37, name: "Western" },
];

/** TMDB TV genre list (subset used for Shows hub rows). */
export const COMMON_TV_GENRES: { id: number; name: string }[] = [
  { id: 10759, name: "Action & Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 10762, name: "Kids" },
  { id: 9648, name: "Mystery" },
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 10768, name: "War & Politics" },
  { id: 37, name: "Western" },
];
