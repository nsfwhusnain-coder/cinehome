export interface QualityRung {
  height: number;
  url: string;
  bitrateBps?: number;
}

export interface ProviderStream {
  url: string;
  quality: string;
  label: string;
  provider: string;
  type?: "hls" | "mp4" | "dash";
  referer: string;
  origin: string;
  userAgent: string;
  maxHeight?: number;
  ladder?: number[];
  qualityRungs?: QualityRung[];
  /** ISO-ish audio language when the provider knows it (`en`, `hi`, `ja`). */
  audioLanguage?: string;
}

export interface TmdbLookup {
  title: string;
  year: string;
  imdbId: string;
  type: "movie" | "tv";
  /** Movie runtime or TV series episode average, when TMDB supplies one. */
  runtimeSeconds: number;
}
