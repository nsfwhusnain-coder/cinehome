/**
 * Client-side TMDB helpers (via `/api/tmdb` proxy).
 * Server-side API lives in `@/lib/tmdb`.
 */

import type { MovieCardData } from "@/components/movie-card";

export type MediaKind = "movie" | "tv";

export type TmdbListItem = MovieCardData & {
  genre_ids?: number[];
  overview?: string;
  popularity?: number;
};

export interface TmdbPagedClient {
  page?: number;
  results?: TmdbListItem[];
  total_pages?: number;
  total_results?: number;
}

/** Stable key for cross-row dedupe: `movie:123` / `tv:456`. */
export function mediaKey(type: string, id: number): string {
  return `${type}:${id}`;
}

export async function tmdbFetch(path: string): Promise<TmdbPagedClient> {
  const res = await fetch(`/api/tmdb/${path}`);
  if (!res.ok) throw new Error(`TMDB ${path} failed`);
  return res.json() as Promise<TmdbPagedClient>;
}

function normalizeListBase(path: string): { kind: "list" | "discover"; base: string } {
  const clean = path.split("?")[0].replace(/^\/+/, "");
  if (clean.startsWith("discover/")) {
    return { kind: "discover", base: clean };
  }
  // list endpoints: movie/popular/1 → movie/popular
  return { kind: "list", base: clean.replace(/\/\d+$/, "") };
}

function pagePath(kind: "list" | "discover", base: string, page: number): string {
  if (kind === "discover") {
    return page <= 1 ? base : `${base}?page=${page}`;
  }
  return `${base}/${page}`;
}

/**
 * Fetch pages 1..pages of a list/discover endpoint and merge unique-by-id results.
 * - list: `movie/popular` or `movie/popular/1` → `/1` `/2` `/3`
 * - discover: `discover/movie/28` → `?page=2` etc.
 */
export async function fetchTmdbPages(basePath: string, pages = 3): Promise<TmdbListItem[]> {
  const { kind, base } = normalizeListBase(basePath);
  const paths = Array.from({ length: pages }, (_, i) => pagePath(kind, base, i + 1));

  const pagesData = await Promise.all(
    paths.map((p) => tmdbFetch(p).catch(() => ({ results: [] as TmdbListItem[] })))
  );

  const seen = new Set<number>();
  const merged: TmdbListItem[] = [];
  for (const page of pagesData) {
    for (const item of page.results ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Trending has no paging in our proxy — merge week + day for volume.
 * Week first (priority), then day fill.
 */
export async function fetchTrendingMerged(mediaType: MediaKind): Promise<TmdbListItem[]> {
  const [week, day] = await Promise.all([
    tmdbFetch(`trending/${mediaType}/week`).catch(() => ({ results: [] as TmdbListItem[] })),
    tmdbFetch(`trending/${mediaType}/day`).catch(() => ({ results: [] as TmdbListItem[] })),
  ]);

  const seen = new Set<number>();
  const merged: TmdbListItem[] = [];
  for (const item of [...(week.results ?? []), ...(day.results ?? [])]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

/**
 * Claim items not already in `seen`, marking them as used.
 * Returns all unique remaining from the pool (target ~30+ when API allows).
 */
export function takeUnique(
  items: TmdbListItem[],
  mediaType: MediaKind,
  seen: Set<string>
): TmdbListItem[] {
  const out: TmdbListItem[] = [];
  for (const item of items) {
    const key = mediaKey(mediaType, item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Seed a seen-set from Continue Watching progress rows. */
export function seedSeenFromContinue(
  seen: Set<string>,
  items: { mediaType: string; tmdbId: number }[] | undefined | null
): void {
  if (!items?.length) return;
  for (const p of items) {
    if (p.mediaType && p.tmdbId != null) {
      seen.add(mediaKey(p.mediaType, p.tmdbId));
    }
  }
}
