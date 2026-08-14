"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl, pickTitleLogoUrl, backdropSrcSet, type TmdbImages } from "@/lib/tmdb";
import { Play, Info, Plus, Star, Calendar, Heart } from "lucide-react";
import { MovieCardData } from "@/components/movie-card";
import { EASE_OUT_EXPO, transitionHero } from "@/lib/motion";
import { COMMON_GENRES, COMMON_TV_GENRES } from "@/lib/tmdb";
import { useWatchlist, type WatchlistItem } from "@/hooks/use-watchlist";
import { useSession } from "next-auth/react";
import { useAmbientColor } from "@/hooks/use-ambient-color";

const CANVAS = "#0a0a0f";

/** Matches navbar.tsx's FOCUS_RING — floating controls over imagery, not a solid surface. */
const HERO_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

/** Layout height only — paint stack may bleed below this for LordFlix-style handoff. */
const HERO_LAYOUT_HEIGHT = "clamp(680px, 92vh, 1040px)";
const IMAGE_BLEED_DESKTOP_PX = 200;
const IMAGE_BLEED_MOBILE_PX = 120;
const CONTENT_PAD_BOTTOM_PX = 108;
const DOTS_BOTTOM_PX = 120;
/** Full image alpha through upper hero; soft die through bleed zone. */
const IMAGE_MASK =
  "linear-gradient(to bottom, #000 0%, #000 40%, transparent 98%)";
/** Soft bottom darken only — never opaque tintTop/CANVAS (that was the hard bar). */
const BOTTOM_SCRIM =
  "linear-gradient(to top, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.22) 28%, transparent 55%)";
const LEFT_SCRIM =
  "linear-gradient(90deg, rgba(10,10,15,0.55) 0%, rgba(10,10,15,0.18) 32%, transparent 58%)";

interface FeaturedItem extends MovieCardData {
  overview: string;
  runtime?: number;
  number_of_seasons?: number;
  genre_ids?: number[];
}

function genreLabel(ids: number[] | undefined, mediaType: string): string | null {
  if (!ids?.length) return null;
  const list = mediaType === "tv" ? COMMON_TV_GENRES : COMMON_GENRES;
  return list.find((g) => g.id === ids[0])?.name ?? null;
}

interface Props {
  items: FeaturedItem[];
}

const SLIDE_INTERVAL_MS = 8000;

interface ProgressRow {
  tmdbId: number;
  mediaType: string;
  progress: number;
  season?: number | null;
  episode?: number | null;
  updatedAt?: string;
}

/** Best in-progress TV episode for a show; null → caller uses S1E1. */
function resumeTvEpisode(
  progressList: ProgressRow[] | undefined,
  tmdbId: number
): { season: number; episode: number } | null {
  if (!progressList?.length) return null;
  const rows = progressList
    .filter(
      (p) =>
        Number(p.tmdbId) === Number(tmdbId) &&
        p.mediaType === "tv" &&
        p.season != null &&
        Number(p.season) > 0 &&
        p.episode != null &&
        Number(p.episode) > 0 &&
        p.progress > 0.02 &&
        p.progress < 0.95
    )
    .sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
  const best = rows[0];
  if (!best) return null;
  return { season: Number(best.season), episode: Number(best.episode) };
}

function HeroTitle({ item, mediaType }: { item: FeaturedItem; mediaType: string }) {
  const { data } = useQuery({
    queryKey: ["tmdb", mediaType, "images", item.id],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/${mediaType}/${item.id}/images`);
      if (!res.ok) return null;
      return res.json() as Promise<TmdbImages>;
    },
    staleTime: 60 * 60 * 1000,
  });

  const logoUrl = pickTitleLogoUrl(data, "w500");
  const title = item.title || item.name || "";

  if (logoUrl) {
    return (
       
      <img
        src={logoUrl}
        alt={title}
        className="h-auto w-auto object-contain drop-shadow-lg"
        style={{ maxWidth: "min(560px, 42vw)" }}
      />
    );
  }

  return (
    <h1
      className="font-display text-[40px] font-extrabold leading-[1.05] tracking-tight text-white drop-shadow-lg md:text-[64px]"
      style={{ fontWeight: 800 }}
    >
      {title}
    </h1>
  );
}

function GlassSegmentedActions({
  onAdd,
  onInfo,
  inList,
}: {
  onAdd: () => void;
  onInfo: () => void;
  inList: boolean;
}) {
  return (
    <div
      className="inline-flex h-11 items-center overflow-hidden rounded-full border border-white/40"
      style={{
        background: "rgba(255,255,255,0.16)",
        WebkitBackdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
        backdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
        boxShadow:
          "inset 0 1px 1px rgba(255,255,255,0.5), 0 4px 14px rgba(0,0,0,0.4)",
      }}
    >
      <button
        type="button"
        onClick={onAdd}
        className={`flex h-11 w-11 items-center justify-center text-white transition-colors hover:bg-white/10 ${HERO_FOCUS_RING}`}
        aria-label={inList ? "In watchlist" : "Add to list"}
      >
        {inList ? (
          <span className="text-sm font-semibold">✓</span>
        ) : (
          <Plus className="h-5 w-5" aria-hidden />
        )}
      </button>
      <span
        className="h-5 w-px shrink-0 self-center"
        style={{ background: "rgba(255,255,255,0.3)" }}
        aria-hidden
      />
      <button
        type="button"
        onClick={onInfo}
        className={`flex h-11 w-11 items-center justify-center text-white transition-colors hover:bg-white/10 ${HERO_FOCUS_RING}`}
        aria-label="More info"
      >
        <Info className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}

export function HeroCarousel({ items }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { isIn, add, remove } = useWatchlist();
  const reduceMotion = useReducedMotion();
  const { data: progressList } = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressRow[];
      return res.json() as Promise<ProgressRow[]>;
    },
    enabled: !!session?.user?.id,
    staleTime: 60_000,
  });
  const [imageBleedPx, setImageBleedPx] = useState(() =>
    typeof window !== "undefined" &&
    !window.matchMedia("(min-width: 768px)").matches
      ? IMAGE_BLEED_MOBILE_PX
      : IMAGE_BLEED_DESKTOP_PX
  );
  const safeIndex = items.length > 0 ? index % items.length : 0;
  const ambientPath =
    items.length > 0
      ? items[safeIndex]?.backdrop_path ?? items[safeIndex]?.poster_path
      : null;
  // Still drives AmbientBackground (page wash under fully-masked image zone).
  useAmbientColor(ambientPath);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () =>
      setImageBleedPx(mq.matches ? IMAGE_BLEED_DESKTOP_PX : IMAGE_BLEED_MOBILE_PX);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (items.length <= 1 || paused) return;
    const id = window.setTimeout(() => {
      setIndex((i) => (i + 1) % items.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(id);
  }, [index, items.length, paused]);

  if (items.length === 0) return null;
  const current = items[safeIndex];
  // Display image: NO crossOrigin — that was breaking the visible load (black void).
  // Color extraction uses a separate Image() with crossOrigin / API fallback.
  // Right-sized (w780/w1280) — never `original` (multi-MB, kills LCP).
  const bgResponsive = backdropSrcSet(current.backdrop_path) ?? backdropSrcSet(current.poster_path);
  const bg = bgResponsive?.src ?? null;
  const year =
    current.release_date || current.first_air_date
      ? new Date((current.release_date || current.first_air_date)!).getFullYear()
      : null;
  const mediaType = current.media_type || "movie";
  const currentTitle = current.title || current.name || "";
  const primaryGenre = genreLabel(current.genre_ids, mediaType);
  const rating =
    current.vote_average && current.vote_average > 0
      ? (Math.round(current.vote_average * 10) / 10).toFixed(1)
      : null;

  const watchlistItem: WatchlistItem = {
    tmdbId: current.id,
    mediaType,
    title: currentTitle,
    poster: current.poster_path,
    backdrop: current.backdrop_path,
    voteAverage: current.vote_average,
    releaseDate: current.release_date || current.first_air_date,
  };
  const inList = session?.user?.id ? isIn(current.id, mediaType) : false;

  return (
    <div
      className="relative w-full"
      style={{
        height: HERO_LAYOUT_HEIGHT,
        backgroundColor: "transparent",
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div aria-live="polite" className="sr-only">
        Now showing: {currentTitle}
      </div>

      {/*
        Paint stack (LordFlix): taller than layout, mask-fades into page ambient.
        overflow-hidden here clips Ken Burns; outer is visible so bleed paints under rails.
        pointer-events-none so Continue Watching cards remain clickable over bleed.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 top-0 z-0"
        style={{
          height: `calc(100% + ${imageBleedPx}px)`,
          overflow: "hidden",
          WebkitMaskImage: IMAGE_MASK,
          maskImage: IMAGE_MASK,
          WebkitMaskSize: "100% 100%",
          maskSize: "100% 100%",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
        }}
      >
        <AnimatePresence mode="sync">
          {bg ? (
            <motion.img
              key={current.id}
              src={bg}
              srcSet={bgResponsive?.srcSet}
              sizes={bgResponsive?.sizes}
              alt=""
              // LCP element — never lazy, hint the browser to fetch it first.
              fetchPriority="high"
              initial={{ opacity: 0, scale: 1 }}
              animate={
                reduceMotion
                  ? { opacity: 1, scale: 1 }
                  : { opacity: 1, scale: 1.06 }
              }
              exit={{ opacity: 0 }}
              transition={
                reduceMotion
                  ? { opacity: { duration: 0.5 } }
                  : {
                      opacity: { duration: 0.85, ease: EASE_OUT_EXPO },
                      scale: { duration: 12, ease: "easeOut" },
                    }
              }
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: "center 20%" }}
            />
          ) : (
            <div className="absolute inset-0" style={{ backgroundColor: CANVAS }} />
          )}
        </AnimatePresence>

        {/* Soft scrims inside mask — dissolve with image; never opaque color wall */}
        <div className="absolute inset-0" style={{ background: BOTTOM_SCRIM }} />
        <div className="absolute inset-0" style={{ background: LEFT_SCRIM }} />
      </div>

      {/* Content — layout box only (not masked); pb keeps Play clear of first rail */}
      <div
        className="absolute inset-x-0 bottom-0 z-[2] pl-14 pr-6"
        style={{ paddingBottom: CONTENT_PAD_BOTTOM_PX }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            className="max-w-[620px]"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={transitionHero}
          >
            <HeroTitle item={current} mediaType={mediaType} />

            <div
              className="hero-meta mt-5 flex flex-wrap items-center gap-x-3 gap-y-1"
              style={{ fontSize: 16, color: "rgba(255,255,255,0.9)" }}
            >
              {rating ? (
                <span className="inline-flex items-center gap-1.5">
                  <Star
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    fill="none"
                    aria-hidden
                  />
                  {rating}/10
                </span>
              ) : null}
              {year ? (
                <span className="inline-flex items-center gap-1.5">
                  <Calendar
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {year}
                </span>
              ) : null}
              {primaryGenre ? (
                <span className="inline-flex items-center gap-1.5">
                  <Heart
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {primaryGenre}
                </span>
              ) : null}
            </div>

            <p
              className="mt-4"
              style={{
                fontSize: 18,
                lineHeight: 1.6,
                color: "rgba(255,255,255,0.92)",
                textShadow: "0 1px 8px rgba(0,0,0,0.5)",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {current.overview}
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (mediaType === "tv") {
                    const resume = resumeTvEpisode(progressList, current.id);
                    const s = resume?.season ?? 1;
                    const e = resume?.episode ?? 1;
                    navigate(`/watch/tv/${current.id}?season=${s}&episode=${e}`);
                  } else {
                    navigate(`/watch/movie/${current.id}`);
                  }
                }}
                className={`inline-flex h-11 items-center gap-2 rounded-full border-0 bg-white px-6 text-[0.9rem] font-semibold uppercase tracking-wide text-black shadow-lg transition-colors hover:bg-white/90 active:scale-[0.98] ${HERO_FOCUS_RING}`}
              >
                <Play className="h-4 w-4 fill-current" aria-hidden />
                Play
              </button>

              <GlassSegmentedActions
                inList={inList}
                onInfo={() => navigate(`/${mediaType}/${current.id}`)}
                onAdd={() => {
                  if (!session?.user?.id) {
                    navigate(`/${mediaType}/${current.id}`);
                    return;
                  }
                  if (inList) {
                    remove.mutate({ tmdbId: current.id, mediaType });
                  } else {
                    add.mutate(watchlistItem);
                  }
                }}
              />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Dots — horizontal, lower-right of banner (LordFlix); stay in layout box */}
      {items.length > 1 ? (
        <div
          className="absolute z-[2] flex items-center gap-1.5"
          style={{ right: 40, bottom: DOTS_BOTTOM_PX }}
        >
          {items.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              className={`flex h-6 items-center justify-center rounded-full px-0.5 ${HERO_FOCUS_RING}`}
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
            >
              <span
                className="relative block overflow-hidden rounded-full"
                style={{
                  height: 6,
                  width: i === index ? 28 : 6,
                  background: "rgba(255,255,255,0.32)",
                  transition: "width 280ms cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                {i === index ? (
                  <span
                    key={`${current.id}-${index}`}
                    className="absolute inset-y-0 left-0 rounded-full bg-white"
                    style={{
                      width: "100%",
                      transformOrigin: "left center",
                      animation: `hero-slide-fill ${SLIDE_INTERVAL_MS}ms linear forwards`,
                      animationPlayState: paused ? "paused" : "running",
                    }}
                  />
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
