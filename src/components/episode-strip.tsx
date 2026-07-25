"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TmdbEpisode } from "@/lib/tmdb";
import { useNavigate } from "@/hooks/use-navigate";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { EpisodeStill } from "@/components/episode-still";

const STILL_WIDTH_SM = "w-40"; // 160px
const STILL_WIDTH_MD = "md:w-[200px]"; // 200px → 200×112 at 16:9
const SKELETON_COUNT = 6;

type SortOrder = "oldest" | "newest";

interface Props {
  tvId: number;
  season: number;
  currentSeason?: number;
  currentEpisode?: number;
  onEpisodeSelect?: (episode: number) => void;
  /** Show Oldest/Newest control above the strip (default true). */
  showSort?: boolean;
  /** Prefer parent-provided art to avoid extra fetches. */
  seriesPosterPath?: string | null;
  seriesBackdropPath?: string | null;
}

function formatRuntime(minutes: number | null | undefined): string | null {
  if (minutes == null || minutes <= 0) return null;
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function EpisodeStrip({
  tvId,
  season,
  currentSeason,
  currentEpisode,
  onEpisodeSelect,
  showSort = true,
  seriesPosterPath,
  seriesBackdropPath,
}: Props) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortOrder>("oldest");

  const { data, isLoading } = useQuery({
    queryKey: ["tmdb", "tv", "season", tvId, season],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${season}`);
      if (!res.ok) return null;
      return res.json() as Promise<{
        poster_path?: string | null;
        episodes?: TmdbEpisode[];
      }>;
    },
  });

  // Fallback series art when parent did not pass it
  const { data: seriesMeta } = useQuery({
    queryKey: ["tmdb", "tv", tvId, "art-fallback"],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}`);
      if (!res.ok) return null;
      return res.json() as Promise<{
        poster_path?: string | null;
        backdrop_path?: string | null;
      }>;
    },
    enabled: !seriesPosterPath && !seriesBackdropPath,
    staleTime: 60 * 60 * 1000,
  });

  const seasonPoster = data?.poster_path ?? null;
  const poster = seriesPosterPath ?? seriesMeta?.poster_path ?? null;
  const backdrop = seriesBackdropPath ?? seriesMeta?.backdrop_path ?? null;

  const episodes = useMemo(() => {
    const list: TmdbEpisode[] = data?.episodes ?? [];
    if (sort === "newest") {
      return [...list].sort((a, b) => b.episode_number - a.episode_number);
    }
    return [...list].sort((a, b) => a.episode_number - b.episode_number);
  }, [data?.episodes, sort]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {showSort ? <Skeleton className="h-8 w-28" /> : null}
        <div className="flex gap-3 overflow-x-auto pb-1">
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <div key={i} className={cn("shrink-0", STILL_WIDTH_SM, STILL_WIDTH_MD)}>
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="mt-2 h-3 w-24 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showSort ? (
        <div className="flex items-center justify-end">
          <Select value={sort} onValueChange={(v) => setSort(v as SortOrder)}>
            <SelectTrigger
              aria-label="Sort episodes"
              className="h-8 w-auto gap-1.5 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
        {episodes.map((ep) => {
          const isCurrent =
            currentEpisode === ep.episode_number && currentSeason === season;
          const duration = formatRuntime(ep.runtime);
          const ariaLabel = `Play episode ${ep.episode_number}: ${ep.name}${
            duration ? `, ${duration}` : ""
          }`;

          return (
            <button
              key={ep.id}
              type="button"
              aria-label={ariaLabel}
              aria-current={isCurrent ? "true" : undefined}
              onClick={() => {
                onEpisodeSelect?.(ep.episode_number);
                navigate(
                  `/watch/tv/${tvId}?season=${season}&episode=${ep.episode_number}`
                );
              }}
              className={cn(
                "group relative shrink-0 overflow-hidden rounded-xl border text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                STILL_WIDTH_SM,
                STILL_WIDTH_MD,
                isCurrent
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border/60 hover:border-border"
              )}
            >
              <div className="relative aspect-video bg-muted">
                <EpisodeStill
                  stillPath={ep.still_path}
                  seasonPosterPath={seasonPoster}
                  seriesBackdropPath={backdrop}
                  seriesPosterPath={poster}
                  episodeNumber={ep.episode_number}
                />

                <span
                  aria-hidden
                  className="absolute left-1.5 top-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white backdrop-blur-sm"
                >
                  E{ep.episode_number}
                </span>

                {duration ? (
                  <span
                    aria-hidden
                    className="absolute bottom-1.5 right-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur-sm"
                  >
                    {duration}
                  </span>
                ) : null}

                <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/35 group-focus-visible:bg-black/35" />
                <div className="absolute inset-0 m-auto flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Play
                    aria-hidden
                    className="h-3.5 w-3.5 translate-x-0.5 fill-current"
                  />
                </div>
              </div>

              <div aria-hidden className="px-2 py-1.5">
                <div className="line-clamp-1 text-xs font-medium leading-snug">
                  {ep.name}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
