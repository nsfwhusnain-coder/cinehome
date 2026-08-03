"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HeroCarousel } from "@/components/hero-carousel";
import { MovieRow } from "@/components/movie-row";
import { MovieCard } from "@/components/movie-card";
import { useMounted } from "@/hooks/use-mounted";
import { Skeleton } from "@/components/ui/skeleton";
import { HeroSkeleton, MovieRowSkeleton } from "@/components/skeletons";
import { BrowseError } from "@/components/empty-states";
import {
  fetchTmdbPages,
  fetchTrendingMerged,
  takeUnique,
  tmdbFetch,
  type MediaKind,
  type TmdbListItem,
} from "@/lib/tmdb-client";
import type { HubRow } from "@/lib/browse-categories";
import { LazyRail } from "@/components/lazy-rail";

const LIST_PAGES = 3;

export interface BrowseHubProps {
  mediaType: MediaKind;
  title: string;
  heroFrom: "trending" | "popular";
  rows: HubRow[];
}

function isTrendingPath(path: string): boolean {
  return path.startsWith("trending/");
}

async function fetchHubRowItems(row: HubRow, mediaType: MediaKind): Promise<TmdbListItem[]> {
  if (isTrendingPath(row.tmdbPath)) {
    return fetchTrendingMerged(mediaType);
  }
  return fetchTmdbPages(row.tmdbPath, LIST_PAGES);
}

export function BrowseHub({ mediaType, title, heroFrom, rows }: BrowseHubProps) {
  const mounted = useMounted();

  const heroPath =
    mediaType === "movie"
      ? heroFrom === "trending"
        ? "trending/movie/week"
        : "movie/popular/1"
      : heroFrom === "trending"
        ? "trending/tv/week"
        : "tv/popular/1";

  const heroQuery = useQuery({
    queryKey: ["tmdb", "hub-hero", mediaType, heroFrom],
    queryFn: () => tmdbFetch(heroPath),
  });

  const rowsQuery = useQuery({
    queryKey: ["tmdb", "hub-rows", mediaType, LIST_PAGES, rows.map((r) => r.id).join("|")],
    queryFn: async () => {
      const settled = await Promise.all(
        rows.map(async (row) => ({
          row,
          items: await fetchHubRowItems(row, mediaType),
        }))
      );
      return settled;
    },
  });

  const dedupedRows = useMemo(() => {
    if (!rowsQuery.data) return null;
    const seen = new Set<string>();
    return rowsQuery.data.map(({ row, items }) => ({
      id: row.id,
      title: row.title,
      items: takeUnique(items, mediaType, seen),
    }));
  }, [rowsQuery.data, mediaType]);

  const featured = (heroQuery.data?.results || []).slice(0, 5).map((m) => ({
    ...m,
    overview: m.overview ?? "",
    media_type: mediaType,
  }));

  const loading = !mounted || heroQuery.isLoading;
  const heroFailed = heroQuery.isError;
  const rowsLoading = rowsQuery.isLoading;
  const rowsFailed = rowsQuery.isError;

  return (
    <div className="pb-12">
      {loading ? (
        <div className="space-y-6">
          <HeroSkeleton />
          <div className="space-y-3 px-4 sm:px-6 lg:px-8">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      ) : heroFailed && !featured.length ? (
        <div className="px-4 pt-24 sm:px-6 lg:px-8">
          <h1 className="mb-6 font-display text-2xl font-bold sm:text-3xl">{title}</h1>
          <BrowseError label={title} onRetry={() => heroQuery.refetch()} />
        </div>
      ) : (
        <>
          {/* Same reason as home: with a hero present the visible h1 below is
              skipped, leaving the page headingless. */}
          {featured.length > 0 ? <h1 className="sr-only">{title}</h1> : null}
          {featured.length > 0 ? <HeroCarousel items={featured} /> : null}

          <div className={`${featured.length ? "-mt-10" : "pt-20"} relative z-10 space-y-10`}>
            {!featured.length ? (
              <div className="px-4 sm:px-6 lg:px-8">
                <h1 className="font-display text-2xl font-bold sm:text-3xl">{title}</h1>
              </div>
            ) : null}

            {rowsLoading ? (
              <>
                <MovieRowSkeleton />
                <MovieRowSkeleton />
                <MovieRowSkeleton />
              </>
            ) : rowsFailed ? (
              <div className="px-4 sm:px-6 lg:px-8">
                <BrowseError label={title} onRetry={() => rowsQuery.refetch()} compact />
              </div>
            ) : (
              dedupedRows?.map((row, rowIndex) =>
                row.items.length ? (
                  /* Home already wrapped its rails in LazyRail; these hub pages
                     never did, so /movies and /shows mounted all 28 rows and
                     every card in them at once - measured 384 images and 799
                     tab stops on /movies. On a television that is the whole page
                     resident in memory and hundreds of D-pad presses to cross.
                     The first two rails render eagerly so the fold is never
                     empty; the rest mount as they approach the viewport. */
                  rowIndex < 2 ? (
                    <MovieRow key={row.id} title={row.title}>
                      {row.items.map((m) => (
                        <MovieCard
                          key={m.id}
                          movie={{ ...m, media_type: mediaType }}
                          forceMediaType={mediaType}
                        />
                      ))}
                    </MovieRow>
                  ) : (
                    <LazyRail key={row.id} minHeight={360}>
                      <MovieRow title={row.title}>
                        {row.items.map((m) => (
                          <MovieCard
                            key={m.id}
                            movie={{ ...m, media_type: mediaType }}
                            forceMediaType={mediaType}
                          />
                        ))}
                      </MovieRow>
                    </LazyRail>
                  )
                ) : null
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
