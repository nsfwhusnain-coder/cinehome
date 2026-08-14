"use client";

import Link from "next/link";
import { tmdbImageUrl, posterSrcSet } from "@/lib/tmdb";
import { cn } from "@/lib/utils";
import { Film, Info, Play } from "lucide-react";
import { CardOverflowMenu } from "@/components/card-overflow-menu";
import {
  preresolvePlayback,
  getMemPlayback,
  playbackMemKey,
  warmPreresolvedPlayback,
} from "@/lib/playback-preresolve";
import { useRef } from "react";

export interface MovieCardData {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number;
  media_type?: string;
  adult?: boolean;
}

interface Props {
  movie: MovieCardData;
  className?: string;
  variant?: "poster" | "backdrop";
  forceMediaType?: "movie" | "tv";
  hideMeta?: boolean;
  hideWatchlist?: boolean;
  /** Hide the top-right "..." menu when the parent supplies its own overlay actions */
  hideOverflowMenu?: boolean;
}

export function MovieCard({
  movie,
  className,
  variant = "poster",
  forceMediaType,
  hideMeta = false,
  hideOverflowMenu = false,
}: Props) {
  const title = movie.title || movie.name || "Untitled";
  const date = movie.release_date || movie.first_air_date;
  const year = date ? new Date(date).getFullYear() : null;
  const mediaType = forceMediaType || movie.media_type || "movie";
  const isPoster = variant === "poster";
  const rating =
    movie.vote_average && movie.vote_average > 0
      ? Math.round(movie.vote_average * 10) / 10
      : null;
  const detailHref = `/${mediaType}/${movie.id}`;
  const playHref =
    mediaType === "tv" ? `/watch/tv/${movie.id}` : `/watch/movie/${movie.id}`;
  const href = isPoster ? playHref : detailHref;
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const posterImg = isPoster ? posterSrcSet(movie.poster_path) : null;
  const imgUrl = isPoster ? posterImg?.src ?? null : tmdbImageUrl(movie.backdrop_path, "w780");
  const fallbackUrl =
    tmdbImageUrl(movie.poster_path, "w342") || tmdbImageUrl(movie.backdrop_path, "w780");

  const line2Parts: string[] = [];
  if (year) line2Parts.push(String(year));
  if (rating != null) line2Parts.push(rating.toFixed(1));

  const kickPreresolve = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const key = playbackMemKey(mediaType, movie.id, mediaType === "tv" ? 1 : undefined, mediaType === "tv" ? 1 : undefined);
      if (getMemPlayback(key)) return;
      void preresolvePlayback({
        mediaType,
        tmdbId: movie.id,
        season: mediaType === "tv" ? 1 : undefined,
        episode: mediaType === "tv" ? 1 : undefined,
      }).then(warmPreresolvedPlayback);
    }, 150);
  };

  const clearHover = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  return (
    <div
      className={cn(
        "group relative shrink-0",
        isPoster
          ? "w-[150px] sm:w-[170px] md:w-[190px]"
          : "w-[240px] md:w-[320px]",
        className
      )}
      onMouseEnter={kickPreresolve}
      onMouseLeave={clearHover}
      onFocus={kickPreresolve}
      onBlur={clearHover}
    >
      <div
        className={cn(
          "relative origin-center overflow-hidden bg-[#14141a] transition-transform duration-[180ms] ease-out will-change-transform",
          "group-hover:scale-105 group-hover:shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
          "group-focus-within:scale-105 group-focus-within:shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
          isPoster ? "aspect-[2/3] rounded-[10px]" : "aspect-video rounded-xl"
        )}
      >
        <Link
          href={href}
          className="absolute inset-0 z-0 block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]"
          aria-label={isPoster ? `Play ${title}` : `Open details for ${title}`}
        >
          {imgUrl ? (
             
            <img
              src={imgUrl}
              srcSet={isPoster ? posterImg?.srcSet : undefined}
              sizes={isPoster ? posterImg?.sizes : undefined}
              alt=""
              loading="lazy"
              width={isPoster ? 190 : 320}
              height={isPoster ? 285 : 180}
              className="h-full w-full object-cover"
              onError={(e) => {
                if (fallbackUrl && e.currentTarget.src !== fallbackUrl) {
                  e.currentTarget.src = fallbackUrl;
                }
              }}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#1a1a22] to-[#0e0e14] p-3 text-center">
              <Film className="h-8 w-8 shrink-0 text-white/25" aria-hidden />
              <span className="line-clamp-3 text-sm text-white/50">{title}</span>
            </div>
          )}
        </Link>

        {isPoster ? (
          <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden>
            <div className="absolute inset-0 bg-black/0 transition-colors duration-[180ms] group-hover:bg-black/35 group-focus-within:bg-black/35" />
            <div className="absolute inset-0 m-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-black opacity-0 transition-opacity duration-[180ms] group-hover:opacity-100 group-focus-within:opacity-100">
              <Play className="h-4 w-4 translate-x-0.5 fill-current" />
            </div>
          </div>
        ) : null}

        {isPoster ? (
          <Link
            href={detailHref}
            tabIndex={-1}
            className="absolute left-1 top-1 z-30 flex h-11 w-11 items-center justify-center opacity-0 transition-opacity duration-[180ms] group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            aria-label={`Details for ${title}`}
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/40 text-white"
              style={{
                background: "rgba(255,255,255,0.16)",
                WebkitBackdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
                backdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
                boxShadow: "inset 0 1px 1px rgba(255,255,255,0.5)",
              }}
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Link>
        ) : null}

        {/* Sibling over link — not inside the <a>. Hidden when parent owns top-right actions. */}
        {!hideOverflowMenu ? (
          <CardOverflowMenu
            target={{
              tmdbId: movie.id,
              mediaType,
              title,
              poster: movie.poster_path,
              backdrop: movie.backdrop_path,
            }}
          />
        ) : null}
      </div>

      {/* Title goes to detail so the poster Play path stays exclusive.
          Out of the tab order — one stop per card on TV. */}
      {!hideMeta ? (
        <Link
          href={detailHref}
          tabIndex={-1}
          aria-hidden="true"
          className="mt-2 block"
        >
          <div
            className="card-title max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-white"
            style={{ fontSize: 15, fontWeight: 600 }}
          >
            {title}
          </div>
          {line2Parts.length > 0 ? (
            <div
              className="mt-0.5 truncate"
              style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}
            >
              {line2Parts.join(" · ")}
            </div>
          ) : null}
        </Link>
      ) : null}
    </div>
  );
}
