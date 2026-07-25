"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { transitionFast } from "@/lib/motion";
import { MovieCard } from "@/components/movie-card";
import { SearchResultsSkeleton } from "@/components/skeletons";
import { EmptyWatchlist } from "@/components/empty-states";
import { useSession } from "next-auth/react";
import { useNavigate } from "@/hooks/use-navigate";
import { useWatchlist } from "@/hooks/use-watchlist";
import { markAsWatched } from "@/lib/watched-history";
import { Bookmark, Check, Home, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  GlassPill,
  GlassPillSegment,
  GlassPillTabs,
  GLASS_PILL_STYLE,
} from "@/components/glass-pill";

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

type SortKey = "recent" | "az" | "rating" | "year";
type Filter = "all" | "movie" | "tv";

export function WatchlistView() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { items, isLoading, remove } = useWatchlist();
  const [sort, setSort] = useState<SortKey>("recent");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    let list = items.filter((i) => filter === "all" || i.mediaType === filter);
    switch (sort) {
      case "az":
        list = [...list].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "rating":
        list = [...list].sort((a, b) => (b.voteAverage || 0) - (a.voteAverage || 0));
        break;
      case "year":
        list = [...list].sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
        break;
      default:
        break;
    }
    return list;
  }, [items, filter, sort]);

  const markWatched = (item: (typeof items)[0]) => {
    markAsWatched({
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      title: item.title,
      poster: item.poster,
      backdrop: item.backdrop,
      voteAverage: item.voteAverage,
      releaseDate: item.releaseDate,
    });
    remove.mutate({ tmdbId: item.tmdbId, mediaType: item.mediaType });
    toast.success("Marked as watched — view in Settings → Already watched");
  };

  if (!session?.user?.id) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-center">
          <Bookmark className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
          <h1 className="font-display mb-2 text-xl font-semibold">Sign in to view your watchlist</h1>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => navigate("/")}>
              <Home className="mr-1.5 h-4 w-4" /> Home
            </Button>
            <Button onClick={() => navigate("/login")}>Sign in</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pb-12 pt-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <GlassPill>
                <GlassPillSegment onClick={() => navigate("/")} aria-label="Home">
                  <Home className="mr-1.5 h-4 w-4" />
                  Home
                </GlassPillSegment>
              </GlassPill>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              My List
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Titles you want to watch. Use ✓ to mark as already watched.
            </p>
          </div>

          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <GlassPillTabs
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "movie", label: "Movies" },
                  { value: "tv", label: "TV" },
                ]}
              />
              <div
                className="relative h-12 rounded-full border border-white/20 px-1"
                style={GLASS_PILL_STYLE}
              >
                <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  <SelectTrigger className="h-10 w-[160px] border-0 bg-transparent text-sm text-white/90 shadow-none focus:ring-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Recently Added</SelectItem>
                    <SelectItem value="az">A-Z</SelectItem>
                    <SelectItem value="rating">Rating</SelectItem>
                    <SelectItem value="year">Year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        {isLoading ? (
          <SearchResultsSkeleton count={8} />
        ) : filtered.length > 0 ? (
          <motion.div
            className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
            variants={staggerContainer}
            initial="hidden"
            animate="show"
          >
            {filtered.map((item) => (
              <motion.div
                key={`${item.mediaType}-${item.tmdbId}`}
                className="group relative"
                variants={fadeUp}
                transition={transitionFast}
              >
                <MovieCard
                  movie={{
                    id: item.tmdbId,
                    title: item.title,
                    poster_path: item.poster ?? null,
                    backdrop_path: item.backdrop,
                    vote_average: item.voteAverage ?? undefined,
                    release_date: item.releaseDate,
                  }}
                  forceMediaType={item.mediaType as "movie" | "tv"}
                  className="w-full"
                  hideWatchlist
                  hideOverflowMenu
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    markWatched(item);
                  }}
                  className="absolute left-2 top-2 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-emerald-400/40 bg-black/75 text-emerald-400 shadow-md backdrop-blur-md hover:bg-emerald-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Mark ${item.title} as watched`}
                >
                  <Check className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    remove.mutate({ tmdbId: item.tmdbId, mediaType: item.mediaType });
                  }}
                  className="absolute right-2 top-2 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-white/25 bg-black/75 text-white shadow-md backdrop-blur-md hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove ${item.title} from watchlist`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </motion.div>
            ))}
          </motion.div>
        ) : items.length > 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="font-display text-lg font-semibold">No matches in this filter</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Your list has {items.length} title{items.length === 1 ? "" : "s"}. Switch to All
              or another filter to see them.
            </p>
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="mt-1 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
            >
              Show all
            </button>
          </div>
        ) : (
          <EmptyWatchlist />
        )}
      </div>
    </div>
  );
}
