"use client";

import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl } from "@/lib/tmdb";
import { transitionContent } from "@/lib/motion";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SeasonPicker } from "@/components/season-picker";
import { EpisodeStrip } from "@/components/episode-strip";
import { BrowseError } from "@/components/empty-states";

interface Props {
  tvId: number;
  season: number;
}

export function TvSeasonView({ tvId, season }: Props) {
  const navigate = useNavigate();

  const {
    data: show,
    isLoading: showLoading,
    isError: showFailed,
    refetch: refetchShow,
  } = useQuery({
    queryKey: ["tmdb", "tv", "details", tvId],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}`);
      if (!res.ok) throw new Error("Failed to load show");
      return res.json();
    },
  });

  const {
    data: seasonData,
    isError: seasonFailed,
    refetch: refetchSeason,
  } = useQuery({
    queryKey: ["tmdb", "tv", "season", tvId, season],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${season}`);
      if (!res.ok) throw new Error("Failed to load season");
      return res.json();
    },
  });

  const poster = tmdbImageUrl(seasonData?.poster_path, "original");

  // Show itself failed to load — nothing else on the page can render meaningfully.
  if (showFailed && !showLoading) {
    return (
      <div className="min-h-screen px-4 pt-24 pb-12 text-center sm:px-6 lg:px-8">
        <BrowseError label="this show" onRetry={() => refetchShow()} />
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pt-20 pb-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <button
          onClick={() => navigate(`/tv/${tvId}`)}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-4 w-4" /> Back to {show?.name || "show"}
        </button>

        <motion.div
          className="flex gap-4 sm:gap-6"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitionContent}
        >
          <div className="hidden sm:block shrink-0 w-32">
            {poster ? (
              <img src={poster} alt={seasonData?.name} className="w-full rounded-2xl shadow-lg" />
            ) : (
              <Skeleton className="w-32 h-48 rounded-2xl" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xl font-bold sm:text-2xl">{show?.name}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-sm font-semibold">Episodes</h2>
              {showLoading || !show?.seasons ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <SeasonPicker
                  seasons={show.seasons}
                  value={season}
                  onChange={(s) => navigate(`/tv/${tvId}/season/${s}`)}
                />
              )}
            </div>
            {seasonData?.overview && (
              <p className="mt-2 text-sm text-muted-foreground max-w-2xl">{seasonData.overview}</p>
            )}

            <div className="mt-5">
              {seasonFailed ? (
                <BrowseError label="episodes" onRetry={() => refetchSeason()} compact />
              ) : (
                <EpisodeStrip
                  tvId={tvId}
                  season={season}
                  showSort
                  seriesPosterPath={show?.poster_path}
                  seriesBackdropPath={show?.backdrop_path}
                />
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
