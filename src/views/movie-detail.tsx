"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { tmdbImageUrl, pickTitleLogoUrl, backdropSrcSet, type TmdbImages, type TmdbWatchProviderRegion } from "@/lib/tmdb";
import { transitionContent } from "@/lib/motion";
import { useNavigate } from "@/hooks/use-navigate";
import { useAmbientColor } from "@/hooks/use-ambient-color";
import { usePrefetchPlayback } from "@/hooks/use-playback";
import { Play, ArrowLeft, Clock, Calendar, PenLine, Wallet, TrendingUp, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailPageSkeleton } from "@/components/skeletons";
import { MovieCard } from "@/components/movie-card";
import { MovieRow } from "@/components/movie-row";
import { RatingBadge } from "@/components/rating-badge";
import { PersonCard } from "@/components/person-card";
import { WatchlistButton } from "@/components/watchlist-button";
import { SeasonPicker } from "@/components/season-picker";
import { EpisodeStrip } from "@/components/episode-strip";
import { GenrePills } from "@/components/genre-pills";
import { BrowseError } from "@/components/empty-states";

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0 },
};

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

interface Props {
  mediaType: "movie" | "tv";
  id: number;
  initialData?: Record<string, any>;
}

const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

function formatLanguage(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function DetailView({ mediaType, id, initialData }: Props) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["tmdb", mediaType, "details", id],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/${mediaType}/${id}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    initialData,
  });

  const { data: images } = useQuery({
    queryKey: ["tmdb", mediaType, "images", id],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/${mediaType}/${id}/images`);
      if (!res.ok) return null;
      return res.json() as Promise<TmdbImages>;
    },
    staleTime: 60 * 60 * 1000,
  });

  useAmbientColor(data?.backdrop_path ?? data?.poster_path);

  const isLoadingFull = isLoading;

  if (isLoadingFull) {
    return (
      <div className="min-h-screen pb-12">
        <DetailPageSkeleton />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 pt-20">
        <BrowseError
          label="this title"
          hint={isError ? "If this keeps happening, check the server's TMDB API key." : undefined}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  const title = data.title || data.name;
  const date = data.release_date || data.first_air_date;
  const year = date ? new Date(date).getFullYear() : null;
  const backdropResponsive = backdropSrcSet(data.backdrop_path);
  const backdrop = backdropResponsive?.src ?? null;
  const watchProviders = data["watch/providers"]?.results?.US as TmdbWatchProviderRegion | undefined;
  const logoUrl = pickTitleLogoUrl(images);
  const cast = data.credits?.cast?.slice(0, 12) || [];
  const directorCredit = data.credits?.crew?.find((c: { job: string }) => c.job === "Director");
  const creditPerson = directorCredit ?? data.created_by?.[0];
  const creditLabel = directorCredit ? "Directed by" : "Created by";
  const recs = data.recommendations?.results?.slice(0, 12) || data.similar?.results?.slice(0, 12) || [];
  const genres = data.genres || [];
  const trailers = (data.videos?.results || []).filter(
    (v: { type: string; site: string }) =>
      (v.type === "Trailer" || v.type === "Teaser") && v.site === "YouTube"
  );
  const reviews = data.reviews?.results || [];
  const certification = pickCertification(data, mediaType);

  return (
    <DetailContent
      mediaType={mediaType}
      id={id}
      data={data}
      title={title}
      year={year}
      backdrop={backdrop}
      backdropSrcSet={backdropResponsive?.srcSet}
      backdropSizes={backdropResponsive?.sizes}
      logoUrl={logoUrl}
      cast={cast}
      creditPerson={creditPerson}
      creditLabel={creditLabel}
      recs={recs}
      genres={genres}
      trailers={trailers}
      reviews={reviews}
      date={date}
      certification={certification}
      watchProviders={watchProviders}
    />
  );
}

function pickCertification(data: Record<string, any>, mediaType: "movie" | "tv"): string | null {
  if (mediaType === "movie") {
    const results = data.release_dates?.results as
      | { iso_3166_1: string; release_dates?: { certification?: string }[] }[]
      | undefined;
    const us = results?.find((r) => r.iso_3166_1 === "US");
    const cert = us?.release_dates?.find((d) => d.certification)?.certification;
    if (cert) return cert;
    for (const r of results ?? []) {
      const c = r.release_dates?.find((d) => d.certification)?.certification;
      if (c) return c;
    }
    return null;
  }
  const results = data.content_ratings?.results as
    | { iso_3166_1: string; rating?: string }[]
    | undefined;
  const us = results?.find((r) => r.iso_3166_1 === "US");
  return us?.rating || results?.find((r) => r.rating)?.rating || null;
}

function formatRuntime(minutes: number | undefined | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** First episode of the first real season — never last_episode_to_air (that jumped to the finale). */
function defaultTvEpisode(data: Record<string, any>): { season: number; episode: number } {
  const firstSeason = (data.seasons as { season_number: number }[] | undefined)?.find(
    (s) => s.season_number > 0
  );
  return { season: firstSeason?.season_number ?? 1, episode: 1 };
}

interface ProgressRow {
  tmdbId: number;
  mediaType: string;
  progress: number;
  season?: number | null;
  episode?: number | null;
  updatedAt?: string;
}

/**
 * Best TV episode to resume: most recently updated in-progress row for this show.
 * Finished episodes (progress ≥ 0.95) are skipped. No rows → null (caller uses S1E1).
 */
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

function DetailContent({
  mediaType,
  id,
  data,
  title,
  year,
  backdrop,
  backdropSrcSet: backdropSrcSetAttr,
  backdropSizes,
  logoUrl,
  cast,
  creditPerson,
  creditLabel,
  recs,
  genres,
  trailers,
  reviews,
  date,
  certification,
  watchProviders,
}: {
  mediaType: "movie" | "tv";
  id: number;
  data: Record<string, any>;
  title: string;
  year: number | null;
  backdrop: string | null;
  backdropSrcSet?: string;
  backdropSizes?: string;
  logoUrl: string | null;
  cast: any[];
  creditPerson?: { name: string };
  creditLabel: string;
  recs: any[];
  genres: any[];
  trailers: { key: string; name?: string; type?: string }[];
  reviews: any[];
  date?: string;
  certification: string | null;
  watchProviders?: TmdbWatchProviderRegion;
}) {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const tvDefault = mediaType === "tv" ? defaultTvEpisode(data) : null;
  const [selectedSeason, setSelectedSeason] = useState<number>(tvDefault?.season ?? 1);
  const [selectedEpisode, setSelectedEpisode] = useState<number>(tvDefault?.episode ?? 1);
  /** Avoid overwriting a manual season/episode pick with progress after user changes picker. */
  const [userPickedEpisode, setUserPickedEpisode] = useState(false);

  const { data: progressList } = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressRow[];
      return res.json() as Promise<ProgressRow[]>;
    },
    enabled: mediaType === "tv" && !!session?.user?.id,
  });

  /**
   * Resume mid-show when progress exists; first open stays at S1E1 (or first
   * season E1). Applied during render off a sync key rather than in an effect,
   * so the episode selector never paints S1E1 for a frame before snapping to
   * the resume point. `userPickedEpisode` still wins outright — once the
   * viewer has chosen, arriving progress must not move the selection under
   * them.
   */
  const resumeKey =
    mediaType === "tv" && !userPickedEpisode ? `${id}:${progressList?.length ?? -1}` : null;
  const [resumeAppliedFor, setResumeAppliedFor] = useState<string | null>(null);
  if (resumeKey !== resumeAppliedFor) {
    setResumeAppliedFor(resumeKey);
    if (resumeKey) {
      const resume = resumeTvEpisode(progressList, id);
      if (resume) {
        setSelectedSeason(resume.season);
        setSelectedEpisode(resume.episode);
      }
    }
  }

  usePrefetchPlayback({
    tmdbId: id,
    mediaType,
    season: mediaType === "tv" ? selectedSeason : undefined,
    episode: mediaType === "tv" ? selectedEpisode : undefined,
  });

  const releaseLabel = date
    ? new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : null;

  return (
    <div className="min-h-screen pb-12">
      {/* Backdrop + logo overlay (no poster boxart) */}
      <div className="relative h-[62vh] min-h-[420px] w-full sm:h-[75vh] sm:min-h-[520px]">
        {backdrop && (
          <img
            src={backdrop}
            srcSet={backdropSrcSetAttr}
            sizes={backdropSizes}
            alt=""
            // Primary LCP candidate on this route — never lazy.
            fetchPriority="high"
            className="h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background from-0% via-background/55 via-35% to-background/15 to-80%" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-transparent to-transparent" />

        <button
          type="button"
          onClick={() => {
            // Deep links land here with no app history — history.back() would dead-end.
            if (typeof window !== "undefined" && window.history.length > 1) {
              window.history.back();
            } else {
              navigate("/");
            }
          }}
          className="absolute left-4 top-20 z-20 flex items-center justify-center rounded-full bg-black/50 p-2 backdrop-blur hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        {/* Bottom-left: logo + meta + actions */}
        <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-8 sm:px-6 sm:pb-12 lg:px-8 lg:pb-16">
          <div className="flex max-w-4xl flex-col gap-4 pr-0 sm:pr-56">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={title}
                className="max-h-24 w-auto max-w-full object-contain drop-shadow sm:max-h-36"
              />
            ) : (
              <h1 className="font-display text-3xl font-bold drop-shadow sm:text-5xl">{title}</h1>
            )}

            {/* Year · Runtime · [Cert] · ★ rating — no status/tagline */}
            <div className="flex flex-wrap items-center gap-2.5 text-sm text-white/70">
              {year ? <span>{year}</span> : null}
              {formatRuntime(data.runtime) ? <span>{formatRuntime(data.runtime)}</span> : null}
              {data.number_of_seasons && !data.runtime ? (
                <span>
                  {data.number_of_seasons} season{data.number_of_seasons > 1 ? "s" : ""}
                </span>
              ) : null}
              {certification ? (
                <span className="rounded-[3px] border-[1.5px] border-white/50 px-[5px] py-px text-[0.75rem] font-semibold tracking-[0.03em] text-white/70">
                  {certification}
                </span>
              ) : null}
              <RatingBadge value={data.vote_average} size="sm" className="text-white/80" />
            </div>

            <GenrePills genres={genres} mediaType={mediaType} />

            <AvailableOnRow providers={watchProviders} />

            {creditPerson && (
              <p className="flex items-center gap-1.5 text-xs text-white/55">
                <PenLine className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {creditLabel} {creditPerson.name}
              </p>
            )}

            {data.overview ? <OverviewText text={data.overview} light /> : null}

            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <Button
                type="button"
                onClick={() =>
                  navigate(
                    mediaType === "tv"
                      ? `/watch/tv/${id}?season=${selectedSeason}&episode=${selectedEpisode}`
                      : `/watch/movie/${id}`
                  )
                }
                size="lg"
                className="rounded-full border-0 bg-white px-6 font-semibold text-[#111] hover:bg-white/85"
              >
                <Play className="mr-1 h-4 w-4 fill-current" />
                {mediaType === "tv" ? `Play S${selectedSeason}E${selectedEpisode}` : "Play"}
              </Button>
              {mediaType === "tv" && data.seasons?.length ? (
                <SeasonPicker
                  seasons={data.seasons}
                  value={selectedSeason}
                  onChange={(s) => {
                    setUserPickedEpisode(true);
                    setSelectedSeason(s);
                    setSelectedEpisode(1);
                  }}
                />
              ) : null}
              <WatchlistButton
                variant="icon"
                className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-[1.5px] border-white/40 bg-white/15 p-0 text-white backdrop-blur-[4px] hover:bg-white/25 [&_svg]:h-5 [&_svg]:w-5"
                item={{
                  tmdbId: id,
                  mediaType,
                  title,
                  poster: data.poster_path,
                  backdrop: data.backdrop_path,
                  voteAverage: data.vote_average,
                  releaseDate: date,
                }}
              />
            </div>
          </div>
        </div>

        {/* Right-side floating info card */}
        <aside className="absolute bottom-8 right-4 z-10 hidden w-52 rounded-2xl border border-white/10 bg-black/55 p-4 text-sm backdrop-blur-md sm:bottom-12 sm:right-6 sm:block lg:right-8">
          {data.runtime ? (
            <InfoCardRow icon={<Clock className="h-3.5 w-3.5" />} label="Runtime" value={`${data.runtime} min`} />
          ) : null}
          {data.original_language ? (
            <InfoCardRow
              icon={<Globe2 className="h-3.5 w-3.5" />}
              label="Language"
              value={formatLanguage(data.original_language)}
            />
          ) : null}
          {releaseLabel ? (
            <InfoCardRow icon={<Calendar className="h-3.5 w-3.5" />} label="Release" value={releaseLabel} />
          ) : null}
          {mediaType === "movie" && data.budget > 0 ? (
            <InfoCardRow
              icon={<Wallet className="h-3.5 w-3.5" />}
              label="Budget"
              value={CURRENCY_FORMAT.format(data.budget)}
            />
          ) : null}
          {mediaType === "movie" && data.revenue > 0 ? (
            <InfoCardRow
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Revenue"
              value={CURRENCY_FORMAT.format(data.revenue)}
            />
          ) : null}
        </aside>
      </div>

      <motion.div
        className="relative z-10 px-4 sm:px-6 lg:px-8"
        initial="hidden"
        animate="show"
        variants={staggerContainer}
      >

        {/* TV: Seasons & Episodes */}
        {mediaType === "tv" && data.seasons?.length ? (
          <motion.section className="mt-10" variants={fadeUp} transition={transitionContent}>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-xl font-semibold">Episodes</h2>
              <SeasonPicker
                seasons={data.seasons}
                value={selectedSeason}
                onChange={(s) => {
                  setUserPickedEpisode(true);
                  setSelectedSeason(s);
                  setSelectedEpisode(1);
                }}
              />
              <button
                type="button"
                onClick={() => navigate(`/tv/${id}/season/${selectedSeason}`)}
                className="ml-auto rounded text-sm font-medium text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                View full season
              </button>
            </div>
            <EpisodeStrip
              tvId={id}
              season={selectedSeason}
              currentSeason={selectedSeason}
              currentEpisode={selectedEpisode}
              onEpisodeSelect={(ep) => {
                setUserPickedEpisode(true);
                setSelectedEpisode(ep);
              }}
              showSort={false}
              seriesPosterPath={data.poster_path}
              seriesBackdropPath={data.backdrop_path}
            />
          </motion.section>
        ) : null}

        {/* Cast — single horizontal scroll row */}
        {cast.length > 0 && (
          <motion.section className="mt-12" variants={fadeUp} transition={transitionContent}>
            <h2 className="font-display mb-4 text-xl font-semibold">Top Cast</h2>
            <div className="scrollbar-hide flex flex-nowrap gap-6 overflow-x-auto overflow-y-hidden pb-3">
              {cast.map((c: any) => (
                <div key={c.id} className="w-20 shrink-0">
                  <PersonCard id={c.id} name={c.name} character={c.character} profilePath={c.profile_path} />
                </div>
              ))}
            </div>
          </motion.section>
        )}

        {/* Trailers section (not in hero) */}
        {trailers.length > 0 && (
          <motion.section className="mt-12" variants={fadeUp} transition={transitionContent}>
            <h2 className="font-display mb-4 text-xl font-semibold">Trailers</h2>
            <div className="scrollbar-hide flex flex-nowrap gap-3 overflow-x-auto pb-2">
              {trailers.slice(0, 8).map((t) => (
                <TrailerCard key={t.key} videoKey={t.key} title={t.name || title} type={t.type} />
              ))}
            </div>
          </motion.section>
        )}

        {reviews.length > 0 && <ReviewsSection reviews={reviews} />}

        {recs.length > 0 && (
          <motion.div className="mt-12" variants={fadeUp} transition={transitionContent}>
            <MovieRow title="You Might Also Like">
              {recs.map((m: any) => (
                <MovieCard
                  key={m.id}
                  movie={{ ...m, media_type: mediaType }}
                  forceMediaType={mediaType}
                  hideMeta
                />
              ))}
            </MovieRow>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

const OVERVIEW_TRUNCATE_LENGTH = 320;
const AVAILABLE_ON_LIMIT = 6;

/** Compact "Available on" row — flatrate first, else rent/buy. Renders nothing without data. */
function AvailableOnRow({ providers }: { providers?: TmdbWatchProviderRegion }) {
  const list = providers?.flatrate ?? providers?.rent ?? providers?.buy ?? [];
  if (!list.length) return null;
  const sorted = [...list]
    .sort((a, b) => a.display_priority - b.display_priority)
    .slice(0, AVAILABLE_ON_LIMIT);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-white/55">Available on</span>
      {sorted.map((p) => {
        const logo = tmdbImageUrl(p.logo_path, "w92");
        return logo ? (
          <img
            key={p.provider_id}
            src={logo}
            alt={p.provider_name}
            title={p.provider_name}
            loading="lazy"
            className="h-7 w-7 rounded-md object-cover ring-1 ring-white/15"
          />
        ) : null;
      })}
    </div>
  );
}

function InfoCardRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/10 py-2 last:border-0 last:pb-0 first:pt-0">
      <span className="flex items-center gap-1.5 text-xs text-white/50">
        {icon}
        {label}
      </span>
      <span className="text-right text-xs font-medium text-white/90">{value}</span>
    </div>
  );
}

function OverviewText({ text, light }: { text: string; light?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > OVERVIEW_TRUNCATE_LENGTH;
  const content = expanded || !long ? text : text.slice(0, OVERVIEW_TRUNCATE_LENGTH) + "…";

  return (
    <div className="max-w-2xl">
      <p className={light ? "text-sm text-white/80 sm:text-base" : "text-sm text-foreground/80 sm:text-base"}>
        {content}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={
            light
              ? "mt-1 border-0 bg-transparent p-0 text-sm font-semibold text-white hover:text-white/90"
              : "mt-1 border-0 bg-transparent p-0 text-sm font-semibold text-white hover:text-white/90"
          }
        >
          {expanded ? "Show less" : "Read More"}
        </button>
      )}
    </div>
  );
}

function TrailerCard({
  videoKey,
  title,
  type,
}: {
  videoKey: string;
  title: string;
  type?: string;
}) {
  const badge = type === "Teaser" ? "Teaser" : "Official Trailer";
  return (
    <a
      href={`https://www.youtube.com/watch?v=${videoKey}`}
      target="_blank"
      rel="noreferrer"
      className="group w-[240px] shrink-0"
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
        <img
          src={`https://img.youtube.com/vi/${videoKey}/hqdefault.jpg`}
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-black/20 transition-colors group-hover:bg-black/30" />
        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-[3px] text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-white">
          {badge}
        </span>
      </div>
      <div className="mt-1.5 text-sm font-medium text-white/80 line-clamp-1">{title}</div>
    </a>
  );
}

function ReviewsSection({ reviews }: { reviews: any[] }) {
  return (
    <motion.section className="mt-12" variants={fadeUp} transition={transitionContent}>
      <h2 className="font-display mb-4 text-xl font-semibold">Reviews</h2>
      <div className="space-y-3">
        {reviews.slice(0, 3).map((r) => (
          <ReviewCard key={r.id} review={r} />
        ))}
      </div>
    </motion.section>
  );
}

function ReviewCard({ review }: { review: any }) {
  const [expanded, setExpanded] = useState(false);
  const long = review.content.length > 400;
  const content = expanded || !long ? review.content : review.content.slice(0, 400) + "…";

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{review.author}</span>
        {review.author_details?.rating ? (
          <RatingBadge value={review.author_details.rating} />
        ) : null}
      </div>
      <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line">{content}</p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 border-0 bg-transparent p-0 text-xs font-semibold text-white hover:text-white/90"
        >
          {expanded ? "Show less" : "Read More"}
        </button>
      )}
    </div>
  );
}
