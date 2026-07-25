/**
 * Fixed category taxonomy for hubs / View All (Appendix C).
 * Proxy paths match `src/app/api/tmdb/[...path]/route.ts` allowlist only.
 */

import { COMMON_GENRES, COMMON_TV_GENRES } from "@/lib/tmdb";

export type MediaKind = "movie" | "tv";

export interface BrowseCategory {
  slug: string;
  title: string;
  mediaType: MediaKind;
  /** Whether load-more via page is supported. */
  paged: boolean;
  /**
   * Path after `/api/tmdb/` for the given page.
   * Genre discover uses path-segment genre id + optional `?page=`.
   * List endpoints use path-segment page.
   */
  tmdbPathForPage: (page: number) => string;
}

export interface HubRow {
  id: string;
  title: string;
  tmdbPath: string;
}

function listPath(prefix: string, page: number): string {
  return `${prefix}/${page}`;
}

function discoverPath(type: MediaKind, genreId: number, page: number): string {
  if (page <= 1) return `discover/${type}/${genreId}`;
  return `discover/${type}/${genreId}?page=${page}`;
}

function genreTitle(type: MediaKind, id: number): string {
  const list = type === "movie" ? COMMON_GENRES : COMMON_TV_GENRES;
  return list.find((g) => g.id === id)?.name ?? `Genre ${id}`;
}

const STATIC_CATEGORIES: Record<string, BrowseCategory> = {
  "trending-movies": {
    slug: "trending-movies",
    title: "Trending Movies",
    mediaType: "movie",
    paged: false,
    tmdbPathForPage: () => "trending/movie/week",
  },
  "now-playing": {
    slug: "now-playing",
    title: "Now Playing",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/now_playing", page),
  },
  "popular-movies": {
    slug: "popular-movies",
    title: "Popular Movies",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/popular", page),
  },
  "top-rated-movies": {
    slug: "top-rated-movies",
    title: "Top Rated Movies",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/top_rated", page),
  },
  "upcoming-movies": {
    slug: "upcoming-movies",
    title: "Upcoming",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) => listPath("movie/upcoming", page),
  },
  "trending-tv": {
    slug: "trending-tv",
    title: "Trending Series",
    mediaType: "tv",
    paged: false,
    tmdbPathForPage: () => "trending/tv/week",
  },
  "popular-tv": {
    slug: "popular-tv",
    title: "Popular Shows",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/popular", page),
  },
  "top-rated-tv": {
    slug: "top-rated-tv",
    title: "Top Rated Series",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/top_rated", page),
  },
  "netflix-movies": {
    slug: "netflix-movies",
    title: "Movies on Netflix",
    mediaType: "movie",
    paged: true,
    tmdbPathForPage: (page) =>
      page <= 1 ? "discover/movie/provider/8" : `discover/movie/provider/8?page=${page}`,
  },
  "netflix-tv": {
    slug: "netflix-tv",
    title: "TV Series on Netflix",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) =>
      page <= 1 ? "discover/tv/provider/8" : `discover/tv/provider/8?page=${page}`,
  },
  "airing-today": {
    slug: "airing-today",
    title: "Airing Today",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/airing_today", page),
  },
  "on-the-air": {
    slug: "on-the-air",
    title: "On The Air",
    mediaType: "tv",
    paged: true,
    tmdbPathForPage: (page) => listPath("tv/on_the_air", page),
  },
};

const GENRE_MOVIE_RE = /^genre-movie-(\d+)$/;
const GENRE_TV_RE = /^genre-tv-(\d+)$/;

/** Resolve a View All slug to a category; unknown → null (404). */
export function resolveCategory(slug: string): BrowseCategory | null {
  const staticCat = STATIC_CATEGORIES[slug];
  if (staticCat) return staticCat;

  const movieGenre = GENRE_MOVIE_RE.exec(slug);
  if (movieGenre) {
    const id = Number(movieGenre[1]);
    return {
      slug,
      title: genreTitle("movie", id),
      mediaType: "movie",
      paged: true,
      tmdbPathForPage: (page) => discoverPath("movie", id, page),
    };
  }

  const tvGenre = GENRE_TV_RE.exec(slug);
  if (tvGenre) {
    const id = Number(tvGenre[1]);
    return {
      slug,
      title: genreTitle("tv", id),
      mediaType: "tv",
      paged: true,
      tmdbPathForPage: (page) => discoverPath("tv", id, page),
    };
  }

  return null;
}

/** Movies hub rows (Appendix C). */
export function movieHubRows(): HubRow[] {
  const base: HubRow[] = [
    { id: "trending-movies", title: "Trending This Week", tmdbPath: "trending/movie/week" },
    { id: "now-playing", title: "Now Playing", tmdbPath: "movie/now_playing/1" },
    { id: "popular-movies", title: "Popular Movies", tmdbPath: "movie/popular/1" },
    { id: "top-rated-movies", title: "Top Rated Movies", tmdbPath: "movie/top_rated/1" },
    { id: "upcoming-movies", title: "Upcoming", tmdbPath: "movie/upcoming/1" },
  ];
  const genres: HubRow[] = COMMON_GENRES.slice(0, 6).map((g) => ({
    id: `genre-movie-${g.id}`,
    title: g.name,
    tmdbPath: `discover/movie/${g.id}`,
  }));
  return [...base, ...genres];
}

/** Shows hub rows (Appendix C, full parity including extended TV lists). */
export function showsHubRows(): HubRow[] {
  const base: HubRow[] = [
    { id: "trending-tv", title: "Trending Shows", tmdbPath: "trending/tv/week" },
    { id: "popular-tv", title: "Popular Shows", tmdbPath: "tv/popular/1" },
    { id: "top-rated-tv", title: "Top Rated Shows", tmdbPath: "tv/top_rated/1" },
    { id: "airing-today", title: "Airing Today", tmdbPath: "tv/airing_today/1" },
    { id: "on-the-air", title: "On The Air", tmdbPath: "tv/on_the_air/1" },
  ];
  const genres: HubRow[] = COMMON_TV_GENRES.slice(0, 6).map((g) => ({
    id: `genre-tv-${g.id}`,
    title: g.name,
    tmdbPath: `discover/tv/${g.id}`,
  }));
  return [...base, ...genres];
}
