"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { EpisodeStill } from "@/components/episode-still";
import { seasonDisplayName } from "@/components/season-picker";
import { cn } from "@/lib/utils";

const GLASS_STYLE: CSSProperties = {
  background: "rgba(18, 18, 22, 0.65)",
  WebkitBackdropFilter: "blur(32px) saturate(180%) brightness(1.12)",
  backdropFilter: "blur(32px) saturate(180%) brightness(1.12)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.5)",
};

interface Props {
  open: boolean;
  tvId: number;
  seasons: { season_number: number; name?: string; episode_count?: number }[];
  season: number;
  episode: number;
  onClose: () => void;
  onSelect: (season: number, episode: number) => void;
}

export function EpisodesPanel({
  open,
  tvId,
  seasons,
  season,
  episode,
  onClose,
  onSelect,
}: Props) {
  const [panelSeason, setPanelSeason] = useState(season);
  const seasonRailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPanelSeason(season);
  }, [season]);

  // Escape key closes panel
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

  const validSeasons = useMemo(
    () => seasons.filter((s) => (s.episode_count ?? 0) > 0 && s.season_number >= 0),
    [seasons]
  );

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
    enabled: open && panelSeason >= 0,
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

  const panelSeasonIndex = validSeasons.findIndex(
    (candidate) => candidate.season_number === panelSeason
  );

  const selectAdjacentSeason = (direction: -1 | 1) => {
    if (panelSeasonIndex < 0) return;
    const next = validSeasons[panelSeasonIndex + direction];
    if (next) setPanelSeason(next.season_number);
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      seasonRailRef.current
        ?.querySelector<HTMLElement>(`[data-season-number="${panelSeason}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, panelSeason]);

  if (!open) return null;

  const episodes = data?.episodes ?? [];
  const seasonPoster = data?.poster_path ?? null;
  const seriesPoster = seriesMeta?.poster_path ?? null;
  const seriesBackdrop = seriesMeta?.backdrop_path ?? null;

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-[55] bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close episodes"
      />
      <div
        className="player-episodes-panel absolute left-3 right-3 z-[60] max-h-[min(55vh,440px)] overflow-hidden rounded-2xl border border-white/20 shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 sm:left-auto sm:right-4 sm:w-[380px]"
        style={GLASS_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Episodes"
      >
        {/* Specular border edge */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{
            padding: 1,
            background:
              "linear-gradient(160deg, rgba(255,255,255,0.48) 0%, rgba(255,255,255,0.06) 42%, rgba(255,255,255,0.16) 100%)",
            WebkitMask:
              "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            WebkitMaskComposite: "xor",
            mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            maskComposite: "exclude",
          }}
        />

        <div className="relative z-[1] flex flex-col max-h-[inherit]">
          {/* Header */}
          <div className="border-b border-white/10 px-3.5 py-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold tracking-tight text-white">Episodes</div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1 text-white/60 hover:bg-white/15 hover:text-white transition"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Season Rail */}
            <div className="mt-2 flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => selectAdjacentSeason(-1)}
                disabled={panelSeasonIndex <= 0}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-25"
                aria-label="Previous season"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              </button>
              <div
                ref={seasonRailRef}
                className="scrollbar-thin flex min-w-0 flex-1 touch-pan-x gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5"
                onWheel={(event) => {
                  const rail = event.currentTarget;
                  if (
                    rail.scrollWidth <= rail.clientWidth ||
                    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  rail.scrollBy({ left: event.deltaY, behavior: "smooth" });
                }}
                aria-label="Seasons"
              >
                {validSeasons.map((s) => {
                  const active = s.season_number === panelSeason;
                  return (
                    <button
                      key={s.season_number}
                      type="button"
                      data-season-number={s.season_number}
                      aria-current={active ? "true" : undefined}
                      onClick={() => setPanelSeason(s.season_number)}
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                        active
                          ? "bg-white text-black font-semibold shadow-sm"
                          : "bg-white/10 text-white/80 hover:bg-white/15"
                      )}
                    >
                      {seasonDisplayName(s.season_number, s.name)}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => selectAdjacentSeason(1)}
                disabled={
                  panelSeasonIndex < 0 || panelSeasonIndex >= validSeasons.length - 1
                }
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-25"
                aria-label="Next season"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>

          {/* Episode List */}
          <div className="flex-1 overflow-y-auto p-2 min-h-0 space-y-1">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-white/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Loading episodes…
              </div>
            ) : episodes.length === 0 ? (
              <div className="py-8 text-center text-xs text-white/50">No episodes found</div>
            ) : (
              episodes.map((ep) => {
                const active =
                  panelSeason === season && ep.episode_number === episode;
                return (
                  <button
                    key={ep.id || ep.episode_number}
                    type="button"
                    onClick={() => {
                      onSelect(panelSeason, ep.episode_number);
                      onClose();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors",
                      active
                        ? "bg-white/20 border border-white/30 text-white shadow-sm"
                        : "hover:bg-white/10 text-zinc-300 border border-transparent"
                    )}
                  >
                    <div className="relative h-11 w-20 shrink-0 overflow-hidden rounded-lg bg-white/10">
                      <EpisodeStill
                        stillPath={ep.still_path}
                        seasonPosterPath={seasonPoster}
                        seriesBackdropPath={seriesBackdrop}
                        seriesPosterPath={seriesPoster}
                        episodeNumber={ep.episode_number}
                        compact
                      />
                      {active && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                          <Check className="h-3.5 w-3.5 text-white" aria-hidden />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-white">
                        {ep.episode_number}. {ep.name || `Episode ${ep.episode_number}`}
                      </div>
                      {ep.runtime ? (
                        <div className="text-[10px] text-white/50">{ep.runtime} min</div>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
