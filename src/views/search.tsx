"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { AlertCircle, Clock, TrendingUp, X } from "lucide-react";
import { transitionFast, transitionView } from "@/lib/motion";
import { MovieCard } from "@/components/movie-card";
import { PersonCard } from "@/components/person-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/hooks/use-mounted";
import {
  SearchBar,
  clearSearchRecents,
  loadSearchRecents,
  removeSearchRecent,
  saveSearchRecent,
} from "@/components/search-bar";
import { EmptySearch } from "@/components/empty-states";
import { useNavigate } from "@/hooks/use-navigate";

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

type Filter = "all" | "movie" | "tv" | "person";

interface Props {
  initialQuery: string;
  initialGenre?: string;
  initialType: Filter;
}

export function SearchView({ initialQuery, initialGenre, initialType }: Props) {
  const mounted = useMounted();
  const navigate = useNavigate();
  const isEmpty = !initialQuery && !initialGenre;
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    if (!mounted || !isEmpty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate recents from localStorage after mount
    setRecents(loadSearchRecents());
  }, [mounted, isEmpty]);

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["tmdb", "search", "multi", initialQuery],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/search/multi?query=${encodeURIComponent(initialQuery)}`);
      if (!res.ok) throw new Error("Search failed. Try again.");
      return res.json();
    },
    enabled: mounted && !!initialQuery && !initialGenre,
    placeholderData: keepPreviousData,
  });

  const {
    data: genreData,
    isLoading: genreLoading,
    isFetching: genreFetching,
    isError: genreError,
    refetch: refetchGenre,
  } = useQuery({
    queryKey: ["tmdb", "discover", "movie", initialGenre],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/discover/movie/${initialGenre}/1`);
      if (!res.ok) throw new Error("Could not load this genre.");
      return res.json();
    },
    enabled: mounted && !!initialGenre,
    placeholderData: keepPreviousData,
  });

  const trending = useQuery({
    queryKey: ["tmdb", "trending", "day", "search-suggest"],
    queryFn: async () => {
      const res = await fetch("/api/tmdb/trending/movie/day");
      if (!res.ok) return { results: [] };
      return res.json();
    },
    enabled: mounted && isEmpty,
    staleTime: 10 * 60 * 1000,
  });

  const loading = initialGenre ? genreLoading : isLoading;
  const fetching = initialGenre ? genreFetching : isFetching;
  const failed = initialGenre ? genreError : isError;
  const allResults = initialGenre
    ? (genreData?.results || []).map((r: Record<string, unknown>) => ({
        ...r,
        media_type: "movie",
      }))
    : (data?.results || []).filter(
        (r: { media_type?: string }) =>
          r.media_type === "movie" || r.media_type === "tv" || r.media_type === "person"
      );

  const counts = useMemo(() => {
    const c = { movie: 0, tv: 0, person: 0 };
    for (const r of allResults as { media_type?: string }[]) {
      if (r.media_type === "movie") c.movie += 1;
      else if (r.media_type === "tv") c.tv += 1;
      else if (r.media_type === "person") c.person += 1;
    }
    return c;
  }, [allResults]);

  const results = allResults.filter(
    (r: { media_type?: string }) => initialType === "all" || r.media_type === initialType
  );

  const setFilter = (f: Filter) => {
    const params = new URLSearchParams();
    if (initialQuery) params.set("q", initialQuery);
    if (initialGenre) params.set("genre", initialGenre);
    if (f !== "all") params.set("type", f);
    navigate(`/search?${params.toString()}`);
  };

  const runRecent = (q: string) => {
    setRecents(saveSearchRecent(q));
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  const heading = initialGenre ? "Browse by genre" : initialQuery;
  const showSkeletons = loading && results.length === 0;
  const showStale = fetching && results.length > 0;

  if (isEmpty) {
    const trendingItems = (trending.data?.results || []).slice(0, 8);
    return (
      <div className="min-h-screen px-4 pb-12 sm:px-6 lg:px-8">
        <motion.div
          className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center text-center"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitionView}
        >
          <h1 className="font-display text-4xl font-bold text-balance sm:text-5xl">
            What would you like to watch?
          </h1>
          <p className="mt-3 max-w-md text-muted-foreground">
            Search movies and TV shows, or pick up a recent search below.
          </p>
          <div className="mt-8 w-full max-w-xl">
            <SearchBar
              initialQuery={initialQuery}
              autoFocus
              size="lg"
              hideRecentDropdown
              onRecentsChange={setRecents}
            />
          </div>

          {recents.length > 0 ? (
            <div className="mt-8 w-full max-w-xl text-left">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-muted-foreground">Recent searches</span>
                <button
                  type="button"
                  onClick={() => {
                    clearSearchRecents();
                    setRecents([]);
                  }}
                  className="inline-flex h-11 items-center rounded-full px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear
                </button>
              </div>
              <ul className="flex flex-wrap justify-center gap-2">
                {recents.map((q) => (
                  <li
                    key={q}
                    role="group"
                    className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/60 py-1 pl-3 pr-1 text-sm transition-colors hover:border-border hover:bg-accent"
                  >
                    <button
                      type="button"
                      onClick={() => runRecent(q)}
                      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 py-1"
                    >
                      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="max-w-[12rem] truncate">{q}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove “${q}” from recent searches`}
                      onClick={() => setRecents(removeSearchRecent(q))}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {trendingItems.length > 0 ? (
            <div className="mt-10 w-full max-w-xl text-left">
              <div className="mb-3 flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" aria-hidden />
                Trending today
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {trendingItems.map((m: { id: number; title?: string; poster_path?: string | null }) => (
                  <MovieCard
                    key={m.id}
                    movie={{ ...m, media_type: "movie" } as never}
                    className="w-[120px]"
                    hideMeta
                  />
                ))}
              </div>
            </div>
          ) : null}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pt-20 pb-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="font-display mb-4 text-2xl font-bold sm:text-3xl">Search</h1>
        <div className="mb-6">
          <SearchBar initialQuery={initialQuery} autoFocus />
        </div>

        <Tabs value={initialType} onValueChange={(v) => setFilter(v as Filter)} className="mb-4">
          <TabsList>
            <TabsTrigger value="all" className="min-h-11">
              All
              {!loading && allResults.length > 0 ? (
                <span className="ml-1.5 text-muted-foreground">({allResults.length})</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="movie" className="min-h-11">
              Movies
              {!loading && counts.movie > 0 ? (
                <span className="ml-1.5 text-muted-foreground">({counts.movie})</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="tv" className="min-h-11">
              TV Shows
              {!loading && counts.tv > 0 ? (
                <span className="ml-1.5 text-muted-foreground">({counts.tv})</span>
              ) : null}
            </TabsTrigger>
            {!initialGenre && (
              <TabsTrigger value="person" className="min-h-11">
                People
                {!loading && counts.person > 0 ? (
                  <span className="ml-1.5 text-muted-foreground">({counts.person})</span>
                ) : null}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        {showStale ? (
          <p className="mb-3 text-xs text-muted-foreground" aria-live="polite">
            Updating results…
          </p>
        ) : null}

        {failed && results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <AlertCircle className="h-10 w-10 text-amber-400" aria-hidden />
            <p className="text-sm font-medium">
              {(error as Error)?.message || "Something went wrong while searching."}
            </p>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 rounded-full"
              onClick={() => (initialGenre ? void refetchGenre() : void refetch())}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {showSkeletons && !failed && (
          <div
            className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
            aria-busy="true"
            aria-label="Loading search results"
          >
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
            ))}
          </div>
        )}

        {!showSkeletons && results.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted-foreground" aria-live="polite">
              {results.length} result{results.length === 1 ? "" : "s"}
              {heading ? ` for “${heading}”` : ""}
              {initialType !== "all" ? ` · ${initialType === "tv" ? "TV" : initialType}` : ""}
            </p>
            <motion.div
              className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
              variants={staggerContainer}
              initial="hidden"
              animate="show"
            >
              {results.map((m: { media_type?: string; id: number; name?: string; profile_path?: string | null }) => (
                <motion.div
                  key={`${m.media_type}-${m.id}`}
                  variants={fadeUp}
                  transition={transitionFast}
                >
                  {m.media_type === "person" ? (
                    <PersonCard id={m.id} name={m.name || ""} profilePath={m.profile_path ?? null} />
                  ) : (
                    <MovieCard movie={m as never} className="w-full" />
                  )}
                </motion.div>
              ))}
            </motion.div>
          </>
        )}

        {!loading && !failed && results.length === 0 && (
          <EmptySearch query={initialQuery || "this genre"} />
        )}
      </div>
    </div>
  );
}
