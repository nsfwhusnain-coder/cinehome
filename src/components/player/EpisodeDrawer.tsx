"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Play, Clock, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EpisodeDrawerProps {
  open: boolean;
  onClose: () => void;
  tvId?: number;
  tvSeasons?: { season_number: number; name?: string; episode_count?: number }[];
  currentSeason?: number;
  currentEpisode?: number;
  onSelectEpisode?: (season: number, episode: number) => void;
  showTitle?: string;
}

interface EpisodeMeta {
  id: number;
  name: string;
  overview: string;
  episode_number: number;
  season_number: number;
  still_path?: string | null;
  runtime?: number | null;
  air_date?: string | null;
}

export function EpisodeDrawer({
  open,
  onClose,
  tvId,
  tvSeasons = [],
  currentSeason = 1,
  currentEpisode = 1,
  onSelectEpisode,
  showTitle = "Episodes",
}: EpisodeDrawerProps) {
  const [selectedSeason, setSelectedSeason] = useState<number>(currentSeason);

  useEffect(() => {
    if (currentSeason != null) {
      setSelectedSeason(currentSeason);
    }
  }, [currentSeason]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Query TMDB for season episodes
  const { data: seasonData, isLoading } = useQuery<{ episodes: EpisodeMeta[] }>({
    queryKey: ["tv-season-episodes", tvId, selectedSeason],
    queryFn: async () => {
      if (!tvId) return { episodes: [] };
      const res = await fetch(`/api/tmdb/tv/${tvId}/season/${selectedSeason}`);
      if (!res.ok) throw new Error("Failed to fetch season episodes");
      return res.json();
    },
    enabled: open && !!tvId && selectedSeason != null,
    staleTime: 1000 * 60 * 30, // 30m cache
  });

  const episodes = seasonData?.episodes ?? [];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-in fade-in duration-200">
      {/* Backdrop overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sliding Drawer */}
      <div className="relative z-10 flex h-full w-full max-w-md flex-col bg-zinc-950/95 border-l border-white/10 shadow-2xl backdrop-blur-2xl animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="min-w-0 pr-3">
            <h2 className="text-base font-semibold text-white truncate">{showTitle}</h2>
            <p className="text-xs text-zinc-400">Select an episode to watch</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Season Selector */}
        {tvSeasons.length > 1 && (
          <div className="border-b border-white/10 px-5 py-3 bg-white/5">
            <div className="relative">
              <select
                value={selectedSeason}
                onChange={(e) => setSelectedSeason(Number(e.target.value))}
                className="w-full appearance-none rounded-lg bg-zinc-900 border border-white/15 px-3.5 py-2 text-sm font-medium text-white focus:outline-none focus:ring-1 focus:ring-white/40 cursor-pointer"
              >
                {tvSeasons.map((s) => (
                  <option key={s.season_number} value={s.season_number} className="bg-zinc-900 text-white">
                    {s.name || `Season ${s.season_number}`} ({s.episode_count || "?"} episodes)
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            </div>
          </div>
        )}

        {/* Episodes List */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-20 w-full animate-pulse rounded-xl bg-white/5" />
              ))}
            </div>
          ) : episodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-zinc-400">
              <p className="text-sm">No episodes found for this season.</p>
            </div>
          ) : (
            episodes.map((ep) => {
              const isCurrent =
                selectedSeason === currentSeason &&
                ep.episode_number === currentEpisode;

              const stillUrl = ep.still_path
                ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
                : null;

              return (
                <div
                  key={ep.id || ep.episode_number}
                  onClick={() => {
                    onSelectEpisode?.(selectedSeason, ep.episode_number);
                    onClose();
                  }}
                  className={cn(
                    "group relative flex gap-3.5 rounded-xl border p-3 cursor-pointer transition-all duration-200",
                    isCurrent
                      ? "border-white/40 bg-white/15 shadow-lg"
                      : "border-white/10 bg-zinc-900/60 hover:border-white/25 hover:bg-zinc-800/80"
                  )}
                >
                  {/* Thumbnail Still */}
                  <div className="relative h-18 w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/10">
                    {stillUrl ? (
                      <img
                        src={stillUrl}
                        alt=""
                        className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-xs font-mono text-zinc-500">
                        E{ep.episode_number}
                      </div>
                    )}
                    {isCurrent && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[1px]">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black shadow">
                          <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex flex-1 flex-col justify-center min-w-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-xs font-mono font-bold text-zinc-400">
                        E{ep.episode_number}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          <Check className="h-2.5 w-2.5" /> Playing
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-white leading-tight truncate group-hover:text-white">
                      {ep.name || `Episode ${ep.episode_number}`}
                    </h3>
                    {ep.runtime ? (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-zinc-400">
                        <Clock className="h-3 w-3" />
                        <span>{ep.runtime}m</span>
                      </div>
                    ) : null}
                    {ep.overview && (
                      <p className="mt-1 text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                        {ep.overview}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
