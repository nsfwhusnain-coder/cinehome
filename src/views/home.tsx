"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { HeroCarousel } from "@/components/hero-carousel";
import { MovieRow } from "@/components/movie-row";
import { MovieCard } from "@/components/movie-card";
import { CardOverflowMenu } from "@/components/card-overflow-menu";
import { NETFLIX_PROVIDER_ID, tmdbImageUrl, withoutAdultTitles } from "@/lib/tmdb";
import { useHideAdult } from "@/hooks/use-hide-adult";
import {
  fetchTmdbPages,
  fetchTrendingMerged,
  seedSeenFromContinue,
  takeUnique,
  type MediaKind,
  type TmdbListItem,
} from "@/lib/tmdb-client";
import { useMounted } from "@/hooks/use-mounted";
import { HeroSkeleton, MovieRowSkeleton } from "@/components/skeletons";
import { LazyRail } from "@/components/lazy-rail";
import { BrowseError } from "@/components/empty-states";
import { cn } from "@/lib/utils";
import {
  abortAllPreresolve,
  preresolvePlayback,
  getMemPlayback,
  playbackMemKey,
  warmPreresolvedPlayback,
} from "@/lib/playback-preresolve";
import { collapseContinueItems } from "@/lib/continue-watching";

const LIST_PAGES = 3;
const RAIL_CARD_LIMIT = 16;
const RAIL_STACK_GAP = 40;
/**
 * Image bleed + mask provide the handoff (LordFlix). Keep 0 — not a positive gutter
 * (exposes hard bar) and not negative-margin-only (rejected; bar stayed).
 */
const HERO_TO_RAIL = 0;

interface ProgressItem {
  mediaType: string;
  tmdbId: number;
  title?: string;
  poster?: string | null;
  backdrop?: string | null;
  progress?: number;
  position?: number;
  duration?: number;
  season?: number | null;
  episode?: number | null;
}

function formatTimeLeft(position?: number, duration?: number, progress?: number): string {
  let remaining = 0;
  if (duration != null && duration > 0 && position != null) {
    remaining = Math.max(0, duration - position);
  } else if (duration != null && duration > 0 && progress != null) {
    remaining = Math.max(0, duration * (1 - progress));
  } else {
    return "";
  }
  const totalMin = Math.round(remaining / 60);
  if (totalMin < 60) return `${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
}

function formatEpMeta(item: ProgressItem, left: string): string {
  const parts: string[] = [];
  // Resume line: "Continue S2 E4 · 12m left" — one show card, not every episode.
  if (item.mediaType === "tv" && item.season != null && item.episode != null) {
    parts.push(`Continue S${item.season} E${item.episode}`);
  }
  if (left) parts.push(left);
  else if (item.progress != null) {
    parts.push(`${Math.round(item.progress * 100)}% watched`);
  }
  return parts.join(" · ");
}

interface HomeCatalog {
  trendingMovies: TmdbListItem[];
  trendingSeries: TmdbListItem[];
  netflixMovies: TmdbListItem[];
  netflixSeries: TmdbListItem[];
  topRatedMovies: TmdbListItem[];
  topRatedSeries: TmdbListItem[];
}

async function fetchHomeCatalog(): Promise<HomeCatalog> {
  // LordFlix home ends after curated rails — no genre rows (Comedy/Crime/…)
  const [
    trendingMovies,
    trendingSeries,
    netflixMovies,
    netflixSeries,
    topRatedMovies,
    topRatedSeries,
  ] = await Promise.all([
    fetchTrendingMerged("movie"),
    fetchTrendingMerged("tv"),
    fetchTmdbPages(`discover/movie/provider/${NETFLIX_PROVIDER_ID}`, LIST_PAGES),
    fetchTmdbPages(`discover/tv/provider/${NETFLIX_PROVIDER_ID}`, LIST_PAGES),
    fetchTmdbPages("movie/top_rated", LIST_PAGES),
    fetchTmdbPages("tv/top_rated", LIST_PAGES),
  ]);

  return {
    trendingMovies,
    trendingSeries,
    netflixMovies,
    netflixSeries,
    topRatedMovies,
    topRatedSeries,
  };
}

/**
 * `fetchTmdbPages`/`fetchTrendingMerged` already swallow per-page fetch errors
 * into `[]` (so one bad rail never blanks the rest) — but that means a total
 * TMDB outage looks identical to "genuinely zero results" for every rail at
 * once. That's the only case six unrelated lists all come back empty
 * simultaneously, so it's the signal used to distinguish "hide this rail"
 * (partial, expected) from "TMDB is down" (total, needs a real error state).
 */
function isTotalCatalogFailure(catalog: HomeCatalog | undefined): boolean {
  if (!catalog) return false;
  return Object.values(catalog).every((list) => list.length === 0);
}



export function HomeView() {
  const mounted = useMounted();
  const { data: session } = useSession();
  const hideAdult = useHideAdult();

  const continueQuery = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressItem[];
      return res.json() as Promise<ProgressItem[]>;
    },
    enabled: !!session,
    staleTime: 60_000,
  });

  const continueItems = useMemo(
    () => collapseContinueItems(continueQuery.data ?? []),
    [continueQuery.data]
  );
  // `/api/progress` returns newest-first, already collapsed to one row per
  // title — so the first item is the single most recently watched thing.
  const recSeed = continueItems[0];
  const recSeedMediaType: MediaKind = recSeed?.mediaType === "tv" ? "tv" : "movie";

  const becauseYouWatchedQuery = useQuery({
    queryKey: ["tmdb", "because-you-watched", recSeedMediaType, recSeed?.tmdbId],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/${recSeedMediaType}/${recSeed!.tmdbId}`);
      if (!res.ok) throw new Error("Failed to load recommendations");
      const data = (await res.json()) as { recommendations?: { results?: TmdbListItem[] } };
      return data.recommendations?.results ?? [];
    },
    enabled: !!recSeed,
    staleTime: 6 * 60 * 60 * 1000,
  });

  const catalog = useQuery({
    queryKey: ["tmdb", "home-catalog-v3", LIST_PAGES],
    queryFn: fetchHomeCatalog,
    staleTime: 6 * 60 * 60 * 1000,
    gcTime: 12 * 60 * 60 * 1000,
  });

  const rows = useMemo(() => {
    if (!catalog.data) return null;

    const seen = new Set<string>();
    seedSeenFromContinue(seen, continueQuery.data);

    // Priority pick for the personalized rail before the general rails claim titles.
    const becauseYouWatched = recSeed
      ? takeUnique(becauseYouWatchedQuery.data ?? [], recSeedMediaType, seen)
      : [];

    return {
      becauseYouWatched: withoutAdultTitles(becauseYouWatched, hideAdult),
      trendingMovies: withoutAdultTitles(takeUnique(catalog.data.trendingMovies, "movie", seen), hideAdult),
      trendingSeries: withoutAdultTitles(takeUnique(catalog.data.trendingSeries, "tv", seen), hideAdult),
      netflixMovies: withoutAdultTitles(takeUnique(catalog.data.netflixMovies, "movie", seen), hideAdult),
      netflixSeries: withoutAdultTitles(takeUnique(catalog.data.netflixSeries, "tv", seen), hideAdult),
      topRatedMovies: withoutAdultTitles(takeUnique(catalog.data.topRatedMovies, "movie", seen), hideAdult),
      topRatedSeries: withoutAdultTitles(takeUnique(catalog.data.topRatedSeries, "tv", seen), hideAdult),
    };
  }, [catalog.data, continueQuery.data, recSeed, recSeedMediaType, becauseYouWatchedQuery.data, hideAdult]);

  const featured = withoutAdultTitles(catalog.data?.trendingMovies ?? [], hideAdult).slice(0, 5).map((m) => ({
    ...m,
    overview: m.overview ?? "",
    media_type: "movie" as const,
  }));

  const hasContinue = !continueQuery.isLoading && continueItems.length > 0;
  const catalogFailed = isTotalCatalogFailure(catalog.data);

  // Background pre-resolve: hero + first 5 CW
  useEffect(() => {
    if (!mounted) return;
    const hero = featured[0];
    if (hero) {
      void preresolvePlayback({ mediaType: "movie", tmdbId: hero.id }).then(
        warmPreresolvedPlayback
      );
    }
    const cw = continueItems.slice(0, 5);
    for (const p of cw) {
      void preresolvePlayback({
        mediaType: p.mediaType,
        tmdbId: p.tmdbId,
        season: p.season ?? undefined,
        episode: p.episode ?? undefined,
      }).then(warmPreresolvedPlayback);
    }
    return () => {
      abortAllPreresolve();
    };
     
  }, [mounted, featured[0]?.id, continueItems]);

  if (catalog.isError && !catalog.data) {
    return (
      <div className="relative pb-12">
        <div className="px-4 pt-24 sm:px-6 lg:px-8">
          <h1 className="mb-6 font-display text-2xl font-bold sm:text-3xl">Home</h1>
          <BrowseError
            label="the home page"
            hint="If this keeps happening, check the server's TMDB API key."
            onRetry={() => catalog.refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    /* Transparent shell so ambient tint wash shows under rails (LordFlix-style) */
    <div className="relative pb-12">
      {/* The hero uses the film's own logo artwork as its title treatment, which
          is right visually but leaves the document with no heading at all on a
          working page - the existing h1s below only render in error states or
          when there is no hero. A visually-hidden heading restores the document
          outline for screen readers and landmark navigation without touching
          the design. */}
      <h1 className="sr-only">Home</h1>
      {/* Shell always paints; data streams in. A resolved-but-empty catalog
          (TMDB outage) gets a real error state here instead of an eternal skeleton. */}
      {!catalog.data ? (
        <HeroSkeleton />
      ) : featured.length ? (
        <HeroCarousel items={featured} />
      ) : (
        <div
          className="flex w-full items-center justify-center"
          style={{ height: "clamp(680px, 92vh, 1040px)" }}
        >
          <BrowseError
            label="featured picks"
            hint="If this keeps happening, check the server's TMDB API key."
            onRetry={() => catalog.refetch()}
          />
        </div>
      )}

      <div
        className="relative z-10 flex flex-col"
        style={{ marginTop: HERO_TO_RAIL, gap: RAIL_STACK_GAP }}
      >
        {continueQuery.isLoading ? (
          <MovieRowSkeleton count={4} />
        ) : hasContinue ? (
          <MovieRow title="Continue Watching" editHref="/continue">
            {continueItems.map((p) => (
              <ContinueCard
                key={`${p.mediaType}-${p.tmdbId}`}
                item={p}
              />
            ))}
          </MovieRow>
        ) : null}

        {!catalog.data ? (
          <>
            <MovieRowSkeleton />
            <MovieRowSkeleton />
          </>
        ) : catalogFailed ? (
          // Hero already carries the primary error + retry; only add a second,
          // compact one here if there's other content on the page to separate it from.
          hasContinue ? (
            <div className="px-4 sm:px-6 lg:px-8">
              <BrowseError label="more titles" onRetry={() => catalog.refetch()} compact />
            </div>
          ) : null
        ) : (
          <>
            {rows?.becauseYouWatched.length ? (
              <MovieRow title={`Because you watched ${recSeed?.title ?? ""}`}>
                {rows.becauseYouWatched.slice(0, RAIL_CARD_LIMIT).map((m) => (
                  <MovieCard
                    key={m.id}
                    movie={{ ...m, media_type: recSeedMediaType }}
                    forceMediaType={recSeedMediaType}
                  />
                ))}
              </MovieRow>
            ) : null}

            {rows?.trendingMovies.length ? (
              <MovieRow title="Trending Movies" viewAllHref="/browse/trending-movies">
                {rows.trendingMovies.slice(0, RAIL_CARD_LIMIT).map((m) => (
                  <MovieCard key={m.id} movie={{ ...m, media_type: "movie" }} />
                ))}
              </MovieRow>
            ) : null}

            {rows?.trendingSeries.length ? (
              <MovieRow title="Trending Series" viewAllHref="/browse/trending-tv">
                {rows.trendingSeries.slice(0, RAIL_CARD_LIMIT).map((m) => (
                  <MovieCard
                    key={m.id}
                    movie={{ ...m, media_type: "tv" }}
                    forceMediaType="tv"
                  />
                ))}
              </MovieRow>
            ) : null}

            {rows?.netflixMovies.length ? (
              <LazyRail minHeight={360}>
                <MovieRow
                  title="Movies on Netflix"
                  viewAllHref="/browse/netflix-movies"
                >
                  {rows.netflixMovies.slice(0, RAIL_CARD_LIMIT).map((m) => (
                    <MovieCard key={m.id} movie={{ ...m, media_type: "movie" }} />
                  ))}
                </MovieRow>
              </LazyRail>
            ) : null}

            {rows?.netflixSeries.length ? (
              <LazyRail minHeight={360}>
                <MovieRow
                  title="TV Series on Netflix"
                  viewAllHref="/browse/netflix-tv"
                >
                  {rows.netflixSeries.slice(0, RAIL_CARD_LIMIT).map((m) => (
                    <MovieCard
                      key={m.id}
                      movie={{ ...m, media_type: "tv" }}
                      forceMediaType="tv"
                    />
                  ))}
                </MovieRow>
              </LazyRail>
            ) : null}

            {rows?.topRatedMovies.length ? (
              <LazyRail minHeight={360}>
                <MovieRow title="Top Rated Movies" viewAllHref="/browse/top-rated-movies">
                  {rows.topRatedMovies.slice(0, RAIL_CARD_LIMIT).map((m) => (
                    <MovieCard key={m.id} movie={{ ...m, media_type: "movie" }} />
                  ))}
                </MovieRow>
              </LazyRail>
            ) : null}

            {rows?.topRatedSeries.length ? (
              <LazyRail minHeight={360}>
                <MovieRow title="Top Rated Series" viewAllHref="/browse/top-rated-tv">
                  {rows.topRatedSeries.slice(0, RAIL_CARD_LIMIT).map((m) => (
                    <MovieCard
                      key={m.id}
                      movie={{ ...m, media_type: "tv" }}
                      forceMediaType="tv"
                    />
                  ))}
                </MovieRow>
              </LazyRail>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ContinueCard({ item }: { item: ProgressItem }) {
  const pct = Math.min(100, Math.max(0, Math.round((item.progress || 0) * 100)));
  const img = tmdbImageUrl(item.backdrop || item.poster, "w780");
  const left = formatTimeLeft(item.position, item.duration, item.progress);
  const line2 = formatEpMeta(item, left);
  const title = item.title ?? "Untitled";
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const href =
    item.mediaType === "tv" && item.season != null && item.episode != null
      ? `/watch/tv/${item.tmdbId}?season=${item.season}&episode=${item.episode}`
      : `/watch/${item.mediaType}/${item.tmdbId}`;

  const kickPreresolve = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const key = playbackMemKey(
        item.mediaType,
        item.tmdbId,
        item.season ?? undefined,
        item.episode ?? undefined
      );
      if (getMemPlayback(key)) return;
      void preresolvePlayback({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        season: item.season ?? undefined,
        episode: item.episode ?? undefined,
      }).then(warmPreresolvedPlayback);
    }, 150);
  };

  return (
    <div
      className="group relative w-[240px] shrink-0 md:w-[320px]"
      onMouseEnter={kickPreresolve}
      onFocus={kickPreresolve}
      onMouseLeave={() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
      }}
    >
      <div
        className={cn(
          "relative aspect-video origin-center overflow-hidden rounded-xl bg-[#14141a]",
          "transition-transform duration-[180ms] ease-out will-change-transform",
          "group-hover:scale-105 group-hover:shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
          "group-focus-within:scale-105 group-focus-within:shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        )}
      >
        <Link
          href={href}
          className="absolute inset-0 z-0 block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]"
          aria-label={`Continue ${title}`}
        >
          {img ? (
            <img
              src={img}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              width={320}
              height={180}
            />
          ) : (
            <div className="h-full w-full bg-[#1a1a22]" />
          )}

          <div
            className="absolute inset-x-0 bottom-0 z-[5]"
            style={{ height: 3, background: "rgba(255,255,255,0.25)" }}
          >
            <div className="h-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        </Link>

        <CardOverflowMenu
          target={{
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
            title,
            poster: item.poster,
            backdrop: item.backdrop,
            season: item.season,
            episode: item.episode,
            duration: item.duration,
            position: item.position,
            continueWatching: true,
          }}
        />
      </div>

      <Link href={href} tabIndex={-1} aria-hidden="true" className="mt-2 block">
        <div className="truncate text-white" style={{ fontSize: 15, fontWeight: 600 }}>
          {title}
        </div>
        {line2 ? (
          <div className="mt-0.5 truncate" style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
            {line2}
          </div>
        ) : null}
      </Link>
    </div>
  );
}
