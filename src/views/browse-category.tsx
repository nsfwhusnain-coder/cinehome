"use client";

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { MovieCard, type MovieCardData } from "@/components/movie-card";
import { SearchResultsSkeleton } from "@/components/skeletons";
import { EmptyBrowse, BrowseError } from "@/components/empty-states";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/hooks/use-mounted";
import { resolveCategory, type MediaKind } from "@/lib/browse-categories";
import { transitionView } from "@/lib/motion";

async function tmdbFetch(path: string) {
  const res = await fetch(`/api/tmdb/${path}`);
  if (!res.ok) throw new Error(`TMDB ${path} failed`);
  return res.json() as Promise<{
    results: MovieCardData[];
    page: number;
    total_pages: number;
  }>;
}

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: transitionView },
};

/** Serializable props only — never pass tmdbPathForPage across the RSC boundary. */
export interface BrowseCategoryViewProps {
  slug: string;
  title: string;
  mediaType: MediaKind;
  paged: boolean;
}

export function BrowseCategoryView({
  slug,
  title,
  mediaType,
  paged,
}: BrowseCategoryViewProps) {
  const mounted = useMounted();
  const [pagesLoaded, setPagesLoaded] = useState(1);

  // Path builder lives in the client module graph via import, not as a prop.
  const pathForPage = useMemo(() => {
    const cat = resolveCategory(slug);
    return (page: number) => cat?.tmdbPathForPage(page) ?? "";
  }, [slug]);

  const firstPath = pathForPage(1);
  const first = useQuery({
    queryKey: ["tmdb", "browse", slug, 1, firstPath],
    queryFn: () => tmdbFetch(firstPath),
    enabled: mounted && !!firstPath,
  });

  const extraPaths = useMemo(() => {
    if (!paged || pagesLoaded <= 1) return [] as string[];
    return Array.from({ length: pagesLoaded - 1 }, (_, i) => pathForPage(i + 2));
  }, [paged, pagesLoaded, pathForPage]);

  const extra = useQueries({
    queries: extraPaths.map((path, i) => ({
      queryKey: ["tmdb", "browse", slug, i + 2, path],
      queryFn: () => tmdbFetch(path),
      enabled: mounted && !!path,
    })),
  });

  const loading = !mounted || first.isLoading;
  const error = first.isError;
  const results = useMemo(() => {
    const pages = [first.data, ...extra.map((q) => q.data)].filter(Boolean);
    const seen = new Set<number>();
    const out: MovieCardData[] = [];
    for (const page of pages) {
      for (const item of page?.results ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [first.data, extra]);

  const totalPages = first.data?.total_pages ?? 1;
  const canLoadMore =
    paged && pagesLoaded < totalPages && !extra.some((q) => q.isFetching);
  const loadingMore = extra.some((q) => q.isFetching);

  return (
    <div className="min-h-screen px-4 pb-12 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-6 font-display text-2xl font-bold sm:text-3xl">{title}</h1>

        {loading ? (
          <SearchResultsSkeleton count={18} />
        ) : error ? (
          <BrowseError label={title} onRetry={() => first.refetch()} />
        ) : results.length === 0 ? (
          <EmptyBrowse label={title} />
        ) : (
          <>
            <motion.div
              className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
              variants={staggerContainer}
              initial="hidden"
              animate="show"
            >
              {results.map((m) => (
                <motion.div key={m.id} variants={fadeUp} className="min-w-0">
                  <MovieCard
                    movie={{ ...m, media_type: mediaType }}
                    forceMediaType={mediaType}
                    className="w-full"
                  />
                </motion.div>
              ))}
            </motion.div>

            {canLoadMore ? (
              <div className="mt-8 flex justify-center">
                <Button
                  variant="secondary"
                  className="rounded-full px-8"
                  disabled={loadingMore}
                  onClick={() => setPagesLoaded((n) => n + 1)}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
