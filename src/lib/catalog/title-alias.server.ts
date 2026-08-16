import { tmdb } from "@/lib/tmdb";
import {
  knownTitleAlias,
  looksLikeUnplayableStub,
  pickBetterCatalogTitle,
  yearFromDate,
  type CatalogTitleHint,
  type PlayableTitle,
} from "./title-alias";

function hintFromSearchRow(row: {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string | null;
  first_air_date?: string | null;
  popularity?: number;
}): CatalogTitleHint | null {
  if (row.media_type !== "movie" && row.media_type !== "tv") return null;
  const title = (row.media_type === "tv" ? row.name : row.title) ?? "";
  if (!title.trim()) return null;
  return {
    id: row.id,
    mediaType: row.media_type,
    title,
    year: yearFromDate(row.release_date ?? row.first_air_date),
    popularity: row.popularity,
  };
}

/**
 * Known stub first. Unknown short movies with no IMDb get a same-named
 * popular title when search overlap is high enough.
 */
export async function resolvePlayableTitle(
  mediaType: "movie" | "tv",
  tmdbId: number
): Promise<PlayableTitle> {
  const known = knownTitleAlias(mediaType, tmdbId);
  if (known) return known;
  if (mediaType !== "movie") return { mediaType, tmdbId };

  const details = await tmdb.movieDetails(tmdbId).catch(() => null);
  if (!details || !looksLikeUnplayableStub(details)) {
    return { mediaType, tmdbId };
  }

  const search = await tmdb.searchMulti(details.title || "").catch(() => null);
  const hints = (search?.results ?? [])
    .map((row) => hintFromSearchRow(row))
    .filter((row): row is CatalogTitleHint => row != null);
  const picked = pickBetterCatalogTitle(
    details.title || "",
    yearFromDate(details.release_date),
    hints,
    { mediaType, tmdbId }
  );
  if (!picked) return { mediaType, tmdbId };
  if (picked.mediaType === "tv") {
    return { mediaType: "tv", tmdbId: picked.id, season: 1, episode: 1 };
  }
  return { mediaType: "movie", tmdbId: picked.id };
}
