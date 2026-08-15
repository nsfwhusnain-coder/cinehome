"use client";

import { useMemo, useState } from "react";
import { tmdbImageUrl } from "@/lib/tmdb";
import { cn } from "@/lib/utils";

export interface EpisodeStillProps {
  stillPath: string | null | undefined;
  /** Season-level poster from TMDB season payload. */
  seasonPosterPath?: string | null;
  /** Series backdrop (wide — good card fill). */
  seriesBackdropPath?: string | null;
  /** Series poster boxart. */
  seriesPosterPath?: string | null;
  episodeNumber: number;
  className?: string;
  /** Compact in-player list thumb. */
  compact?: boolean;
}

/**
 * Episode card art with graceful fallbacks when TMDB has no still_path.
 * Order: still → season poster → series backdrop → series poster → letter badge.
 */
export function EpisodeStill({
  stillPath,
  seasonPosterPath,
  seriesBackdropPath,
  seriesPosterPath,
  episodeNumber,
  className,
  compact = false,
}: EpisodeStillProps) {
  const candidates = useMemo(() => {
    const urls: string[] = [];
    const still = tmdbImageUrl(stillPath, "original");
    if (still) urls.push(still);
    const season = tmdbImageUrl(seasonPosterPath, "original");
    if (season) urls.push(season);
    const backdrop = tmdbImageUrl(seriesBackdropPath, "original");
    if (backdrop) urls.push(backdrop);
    const poster = tmdbImageUrl(seriesPosterPath, "original");
    if (poster) urls.push(poster);
    return urls;
  }, [stillPath, seasonPosterPath, seriesBackdropPath, seriesPosterPath]);

  const [index, setIndex] = useState(0);
  const src = candidates[index] ?? null;

  if (!src) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-card",
          className
        )}
        aria-hidden
      >
        <span
          className={cn(
            "font-semibold tabular-nums text-muted-foreground/70",
            compact ? "text-[10px]" : "text-xs"
          )}
        >
          E{episodeNumber}
        </span>
      </div>
    );
  }

  return (
     
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn("h-full w-full object-contain", className)}
      onError={() => {
        setIndex((i) => (i + 1 < candidates.length ? i + 1 : candidates.length));
      }}
    />
  );
}
