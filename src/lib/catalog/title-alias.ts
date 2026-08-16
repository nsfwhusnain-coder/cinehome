/**
 * TMDB sometimes lists a 5-minute "Barbie Dream House" movie with no IMDb
 * id and no streams. Household search hits that stub. Map unplayable stubs
 * onto the real, same-named title.
 */

export const STUB_RUNTIME_MAX_MIN = 20;
export const TITLE_OVERLAP_MIN = 0.66;

export interface PlayableTitle {
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
}

export interface CatalogTitleHint {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number | null;
  popularity?: number;
}

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "a",
  "of",
  "in",
  "to",
]);

/** Known household stubs → the playable title people actually want. */
export const KNOWN_TITLE_ALIASES: Readonly<Record<string, PlayableTitle>> = {
  "movie:1291377": { mediaType: "tv", tmdbId: 89092, season: 1, episode: 1 },
};

export function catalogKey(
  mediaType: "movie" | "tv",
  tmdbId: number
): string {
  return `${mediaType}:${tmdbId}`;
}

export function knownTitleAlias(
  mediaType: "movie" | "tv",
  tmdbId: number
): PlayableTitle | null {
  return KNOWN_TITLE_ALIASES[catalogKey(mediaType, tmdbId)] ?? null;
}

export function looksLikeUnplayableStub(details: {
  imdb_id?: string | null;
  runtime?: number | null;
}): boolean {
  const imdb = details.imdb_id?.trim() ?? "";
  if (imdb) return false;
  const runtime = details.runtime ?? 0;
  return runtime > 0 && runtime <= STUB_RUNTIME_MAX_MIN;
}

export function catalogTokens(text: string): string[] {
  const raw = text.toLowerCase().replace(/['’]/g, "");
  const parts = raw.split(/[^a-z0-9]+/).filter((token) => {
    if (token.length < 3) return false;
    return !STOP_TOKENS.has(token);
  });
  const extra: string[] = [];
  for (const part of parts) {
    if (part.endsWith("house") && part.length > 7) {
      extra.push(part.slice(0, -5), "house");
    }
  }
  return [...new Set([...parts, ...extra])];
}

export function titleOverlapRatio(query: string, candidate: string): number {
  const wanted = catalogTokens(query);
  if (!wanted.length) return 0;
  const have = new Set(catalogTokens(candidate));
  const hits = wanted.filter((token) => have.has(token)).length;
  return hits / wanted.length;
}

export function yearFromDate(value?: string | null): number | null {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) && year >= 1900 ? year : null;
}

export function scoreCatalogCandidate(
  queryTitle: string,
  queryYear: number | null,
  candidate: CatalogTitleHint
): number {
  const overlap = titleOverlapRatio(queryTitle, candidate.title);
  if (overlap < TITLE_OVERLAP_MIN) return 0;
  let score = overlap * 100;
  if (queryYear && candidate.year) {
    const delta = Math.abs(queryYear - candidate.year);
    if (delta === 0) score += 20;
    else if (delta === 1) score += 10;
    else if (delta > 5) score -= 15;
  }
  if (candidate.mediaType === "tv") score += 8;
  score += Math.min(12, (candidate.popularity ?? 0) / 20);
  return score;
}

export function pickBetterCatalogTitle(
  queryTitle: string,
  queryYear: number | null,
  candidates: readonly CatalogTitleHint[],
  current: { mediaType: "movie" | "tv"; tmdbId: number }
): CatalogTitleHint | null {
  let best: CatalogTitleHint | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (
      candidate.mediaType === current.mediaType &&
      candidate.id === current.tmdbId
    ) {
      continue;
    }
    const score = scoreCatalogCandidate(queryTitle, queryYear, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= TITLE_OVERLAP_MIN * 100 ? best : null;
}

export function rewriteSearchResult<
  T extends {
    id: number;
    media_type?: string;
    title?: string;
    name?: string;
  },
>(item: T): T {
  const mediaType = item.media_type === "tv" ? "tv" : "movie";
  if (item.media_type !== "movie" && item.media_type !== "tv") return item;
  const alias = knownTitleAlias(mediaType, item.id);
  if (!alias) return item;
  if (alias.mediaType === mediaType && alias.tmdbId === item.id) return item;
  return {
    ...item,
    id: alias.tmdbId,
    media_type: alias.mediaType,
    ...(alias.mediaType === "tv"
      ? { name: item.name || item.title }
      : { title: item.title || item.name }),
  };
}

export function rewriteSearchResults<
  T extends { id: number; media_type?: string },
>(results: readonly T[]): T[] {
  const rewritten = results.map((item) => rewriteSearchResult(item));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of rewritten) {
    const type = item.media_type ?? "movie";
    const key = `${type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function playableHref(title: PlayableTitle): string {
  if (title.mediaType === "tv") {
    const season = title.season ?? 1;
    const episode = title.episode ?? 1;
    return `/watch/tv/${title.tmdbId}?season=${season}&episode=${episode}`;
  }
  return `/watch/movie/${title.tmdbId}`;
}

export function detailHref(title: PlayableTitle): string {
  return `/${title.mediaType}/${title.tmdbId}`;
}
