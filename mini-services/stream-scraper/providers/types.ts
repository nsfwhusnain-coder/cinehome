export interface ProviderStream {
  url: string;
  quality: string;
  label: string;
  provider: string;
  type?: "hls" | "mp4" | "dash";
  referer: string;
  origin: string;
  userAgent: string;
}

export interface TmdbLookup {
  title: string;
  year: string;
  imdbId: string;
  type: "movie" | "tv";
  /** Movie runtime or TV series episode average, when TMDB supplies one. */
  runtimeSeconds: number;
}
