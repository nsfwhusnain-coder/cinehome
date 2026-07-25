import type { TmdbLookup } from "./types";

const TMDB_KEY = process.env.TMDB_API_KEY || "";

export async function lookupTmdb(
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
    };
    const title = data.title || data.name || "";
    const year = (data.release_date || data.first_air_date || "").split("-")[0];
    const imdbId = data.external_ids?.imdb_id || "";
    if (!title) return null;
    return { title, year, imdbId, type };
  } catch {
    return null;
  }
}