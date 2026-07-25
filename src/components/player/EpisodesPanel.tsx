"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Check, Loader2 } from "lucide-react";
import { EpisodeStill } from "@/components/episode-still";

export interface SeasonOption {
  season_number: number;
  name?: string;
  episode_count?: number;
}

interface Props {
  open: boolean;
  tvId: number;
  seasons: SeasonOption[];
  season: number;
  episode: number;
  onClose: () => void;
  onSelect: (season: number, episode: number) => void;
}

/**
 * In-player season/episode picker (TV only).
 */
export function EpisodesPanel({
  open,
  tvId,
  seasons,
  season,
  episode,
  onClose,
  onSelect,
}: Props) {
  const validSeasons = useMemo(
    () =>
      seasons
        .filter((s) => s.season_number > 0)
        .sort((a, b) => a.season_number - b.season_number),
    [seasons]
  );

  const [panelSeason, setPanelSeason] = useState(season);

  useEffect(() => {
    if (open) setPanelSeason(season);
  }, [open, season]);

  const { data, isLoading } = useQuery({
    queryKey: ["tmdb", "tv", "season", tvId, panelSeason],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${panelSeason}`);
      if (!res.ok) return null;
      return res.json() as Promise<{
        poster_path?: string | null;
        episodes?: {
          id: number;
          episode_number: number;
          name: string;
          still_path: string | null;
          runtime?: number | null;
        }[];
      }>;
    },
    enabled: open && panelSeason > 0,
    staleTime: 10 * 60 * 1000,
  });

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
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });

  if (!open) return null;

  const episodes = data?.episodes ?? [];
  const seasonPoster = data?.poster_path ?? null;
  const seriesPoster = seriesMeta?.poster_path ?? null;
  const seriesBackdrop = seriesMeta?.backdrop_path ?? null;

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-[55] bg-black/40"
        onClick={onClose}
        aria-label="Close episodes"
      />
      <div
        className="absolute bottom-[60px] left-3 right-3 z-[60] max-h-[min(55vh,420px)] overflow-hidden rounded-xl border border-white/10 bg-[rgba(15,15,15,0.96)] shadow-2xl backdrop-blur-xl sm:left-auto sm:right-4 sm:w-[360px]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Episodes"
      >
        <div className="border-b border-white/10 px-3 py-2.5">
          <div className="text-sm font-semibold text-white">Episodes</div>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
            {validSeasons.map((s) => {
              const active = s.season_number === panelSeason;
              return (
                <button
                  key={s.season_number}
                  type="button"
                  onClick={() => setPanelSeason(s.season_number)}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-white text-black"
                      : "bg-white/10 text-white/80 hover:bg-white/15"
                  )}
                >
                  {s.name || `Season ${s.season_number}`}
                </button>
              );
            })}
          </div>
        </div>

        <div className="max-h-[min(40vh,320px)] overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading episodes…
            </div>
          ) : episodes.length === 0 ? (
            <div className="py-8 text-center text-sm text-white/50">No episodes found</div>
          ) : (
            <ul className="space-y-1">
              {episodes.map((ep) => {
                const active =
                  panelSeason === season && ep.episode_number === episode;
                return (
                  <li key={ep.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(panelSeason, ep.episode_number);
                        onClose();
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.06]",
                        active && "bg-white/[0.1]"
                      )}
                    >
                      <div className="relative h-12 w-[86px] shrink-0 overflow-hidden rounded-md bg-white/10">
                        <EpisodeStill
                          stillPath={ep.still_path}
                          seasonPosterPath={seasonPoster}
                          seriesBackdropPath={seriesBackdrop}
                          seriesPosterPath={seriesPoster}
                          episodeNumber={ep.episode_number}
                          compact
                        />
                        {active ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Check className="h-4 w-4 text-white" aria-hidden />
                          </div>
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {ep.episode_number}. {ep.name || `Episode ${ep.episode_number}`}
                        </div>
                        {ep.runtime ? (
                          <div className="text-[11px] text-white/45">{ep.runtime} min</div>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
