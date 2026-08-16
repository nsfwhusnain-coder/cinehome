import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { tmdb } from "@/lib/tmdb";
import { cachedFetch } from "@/lib/server-cache";
import { rewriteSearchResults } from "@/lib/catalog/title-alias";

/**
 * Generic TMDB proxy. Lets us call TMDB from the client without exposing the API key.
 *
 * Usage:
 *   GET /api/tmdb/trending/movie/week
 *   GET /api/tmdb/movie/550?append_to_response=credits,videos
 *   GET /api/tmdb/search/movie?query=inception
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (!path?.length) return NextResponse.json({ error: "Missing path" }, { status: 400 });

  const route = "/" + path.join("/");
  const url = new URL(_req.url);
  const params: Record<string, string | number | boolean> = {};
  url.searchParams.forEach((v, k) => {
    if (k === "XTransformPort") return;
    params[k] = v;
  });

  try {
    const [a, b, c] = path;
    const cacheKey = `tmdb:${route}:${JSON.stringify(params)}`;

    const data = await cachedFetch(cacheKey, async () => {
      if (a === "trending" && b === "movie") {
        return tmdb.trending((c as "day" | "week") || "week");
      }
      if (a === "trending" && b === "tv") {
        return tmdb.trendingTv((c as "day" | "week") || "week");
      }
      if (a === "movie" && b === "popular") {
        return tmdb.popularMovies(Number(c) || 1);
      }
      if (a === "movie" && b === "top_rated") {
        return tmdb.topRatedMovies(Number(c) || 1);
      }
      if (a === "movie" && b === "upcoming") {
        return tmdb.upcomingMovies(Number(c) || 1);
      }
      if (a === "movie" && b === "now_playing") {
        return tmdb.nowPlaying(Number(c) || 1);
      }
      if (a === "tv" && b === "popular") {
        return tmdb.popularTv(Number(c) || 1);
      }
      if (a === "tv" && b === "top_rated") {
        return tmdb.topRatedTv(Number(c) || 1);
      }
      if (a === "tv" && b === "airing_today") {
        return tmdb.airingTodayTv(Number(c) || 1);
      }
      if (a === "tv" && b === "on_the_air") {
        return tmdb.onTheAirTv(Number(c) || 1);
      }
      if (a === "movie" && b && !isNaN(Number(b)) && c === "images") {
        return tmdb.movieImages(Number(b));
      }
      if (a === "tv" && b && !isNaN(Number(b)) && c === "images") {
        return tmdb.tvImages(Number(b));
      }
      if (a === "tv" && b && !isNaN(Number(b)) && c === "season") {
        const d = path[3];
        return tmdb.tvSeason(Number(b), Number(d));
      }
      if (a === "movie" && b && !isNaN(Number(b))) {
        return tmdb.movieDetails(Number(b));
      }
      if (a === "tv" && b && !isNaN(Number(b))) {
        return tmdb.tvDetails(Number(b));
      }
      if (a === "search" && b === "movie") {
        const found = await tmdb.search(
          params.query as string,
          Number(params.page) || 1
        );
        return {
          ...found,
          results: rewriteSearchResults(
            (found.results ?? []).map((row) => ({
              ...row,
              media_type: row.media_type ?? "movie",
            }))
          ),
        };
      }
      if (a === "search" && b === "multi") {
        const found = await tmdb.searchMulti(
          params.query as string,
          Number(params.page) || 1
        );
        return {
          ...found,
          results: rewriteSearchResults(found.results ?? []),
        };
      }
      if (a === "genre" && (b === "movie" || b === "tv")) {
        return tmdb.genres(b);
      }
      if (a === "discover" && (b === "movie" || b === "tv") && c === "provider" && path[3]) {
        return tmdb.discoverByWatchProvider(
          b,
          Number(path[3]),
          Number(params.page) || 1,
          (params.region as string) || "US"
        );
      }
      if (a === "discover" && (b === "movie" || b === "tv") && c) {
        return tmdb.discoverByGenre(b, Number(c), Number(params.page) || 1);
      }
      if (a === "person" && b && !isNaN(Number(b)) && c === "combined_credits") {
        return tmdb.personCredits(Number(b));
      }
      if (a === "person" && b && !isNaN(Number(b))) {
        return tmdb.personDetails(Number(b));
      }
      throw Object.assign(new Error(`Unknown TMDB route: ${route}`), { status: 404 });
    });

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=21600",
        "X-Catalog-Cache": "SWR",
      },
    });
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status === 404 ? 404 : 500;
    const message = e instanceof Error ? e.message : "TMDB request failed";
    return NextResponse.json({ error: message }, { status });
  }
}