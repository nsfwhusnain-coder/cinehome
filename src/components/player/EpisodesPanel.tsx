"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

function visibleButtons(root: HTMLElement, selector: string): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(selector)).filter(
    (button) => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return (
        !button.disabled &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden"
      );
    }
  );
}

function focusButton(
  button: HTMLButtonElement | null | undefined
): void {
  button?.focus();
  button?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) setPanelSeason(season);
  }, [open, season]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const selected =
        panel.querySelector<HTMLButtonElement>("[data-episode-panel-season][aria-selected='true']") ??
        panel.querySelector<HTMLButtonElement>("[data-episode-panel-season]");
      focusButton(selected ?? undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    };
  }, [open]);

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

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    const seasons = visibleButtons(panel, "[data-episode-panel-season]");
    const episodes = visibleButtons(panel, "[data-episode-panel-episode]");
    const all = [...seasons, ...episodes];
    const current =
      document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : null;

    if (event.key === "Tab") {
      if (!all.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = current ? all.indexOf(current) : -1;
      const delta = event.shiftKey ? -1 : 1;
      focusButton(all[index < 0 ? 0 : (index + delta + all.length) % all.length]);
      return;
    }

    const seasonIndex = current ? seasons.indexOf(current) : -1;
    if (seasonIndex >= 0) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        focusButton(
          seasons[(seasonIndex + delta + seasons.length) % seasons.length]
        );
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        const currentEpisode = episodes.find(
          (button) => button.dataset.episodeCurrent === "true"
        );
        focusButton(currentEpisode ?? episodes[0]);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        focusButton(current ?? seasons[seasonIndex]);
        return;
      }
    }

    const episodeIndex = current ? episodes.indexOf(current) : -1;
    if (episodeIndex >= 0) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowUp" && episodeIndex === 0) {
          focusButton(
            seasons.find((button) => button.getAttribute("aria-selected") === "true") ??
              seasons[0]
          );
          return;
        }
        const delta = event.key === "ArrowUp" ? -1 : 1;
        const nextIndex = Math.max(
          0,
          Math.min(episodes.length - 1, episodeIndex + delta)
        );
        focusButton(episodes[nextIndex]);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        focusButton(current);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-[55] bg-black/40"
        onClick={onClose}
        aria-label="Close episodes"
      />
      <div
        ref={panelRef}
        className="absolute bottom-[60px] left-3 right-3 z-[60] max-h-[min(55vh,420px)] overflow-hidden rounded-xl border border-white/10 bg-[rgba(15,15,15,0.96)] shadow-2xl backdrop-blur-xl sm:left-auto sm:right-4 sm:w-[360px]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Episodes"
      >
        <div className="border-b border-white/10 px-3 py-2.5">
          <div className="text-sm font-semibold text-white">Episodes</div>
          <div
            className="mt-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide"
            role="tablist"
            aria-label="Seasons"
          >
            {validSeasons.map((s) => {
              const active = s.season_number === panelSeason;
              return (
                <button
                  key={s.season_number}
                  type="button"
                  onClick={() => setPanelSeason(s.season_number)}
                  data-episode-panel-season
                  role="tab"
                  aria-selected={active}
                  className={cn(
                    "min-h-11 shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
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
                      data-episode-panel-episode
                      data-episode-current={active ? "true" : undefined}
                      onClick={() => {
                        onSelect(panelSeason, ep.episode_number);
                        onClose();
                      }}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
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
