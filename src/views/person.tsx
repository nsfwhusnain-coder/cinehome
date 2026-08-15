"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Play, ArrowLeft, Calendar, MapPin } from "lucide-react";
import { useSession } from "next-auth/react";
import { useNavigate } from "@/hooks/use-navigate";
import { MovieCard } from "@/components/movie-card";
import { MovieRow } from "@/components/movie-row";
import { PersonError } from "@/components/empty-states";
import { transitionContent, transitionView } from "@/lib/motion";
import { tmdbImageUrl, withoutAdultTitles, type TmdbPerson, type TmdbPersonCredit, type TmdbPersonCredits } from "@/lib/tmdb";
import { useHideAdult } from "@/hooks/use-hide-adult";
import { Button } from "@/components/ui/button";

const FILMOGRAPHY_LIMIT = 24;
const BIO_CLAMP = 420;

interface Props {
  id: number;
  initialPerson?: TmdbPerson | null;
  initialCredits?: TmdbPersonCredits | null;
}

function creditTitle(credit: TmdbPersonCredit): string {
  return credit.title || credit.name || "Untitled";
}

function creditYear(credit: TmdbPersonCredit): number | null {
  const date = credit.release_date || credit.first_air_date;
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : null;
}

function creditScore(credit: TmdbPersonCredit): number {
  return (credit.popularity ?? 0) * 10 + (credit.vote_average ?? 0);
}

interface ProgressRow {
  tmdbId: number;
  mediaType: string;
  progress: number;
  season?: number | null;
  episode?: number | null;
  updatedAt?: string;
}

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
        Number(p.season) >= 0 &&
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

function watchHref(
  credit: TmdbPersonCredit,
  resume: { season: number; episode: number } | null
): string {
  if (credit.media_type === "tv") {
    if (resume) {
      return `/watch/tv/${credit.id}?season=${resume.season}&episode=${resume.episode}`;
    }
    return `/watch/tv/${credit.id}`;
  }
  return `/watch/movie/${credit.id}`;
}

function lifespan(person: TmdbPerson): string | null {
  if (!person.birthday) return null;
  const born = new Date(person.birthday).getFullYear();
  if (!Number.isFinite(born)) return null;
  if (person.deathday) {
    const died = new Date(person.deathday).getFullYear();
    return Number.isFinite(died) ? `${born} – ${died}` : String(born);
  }
  return String(born);
}

function collectFilmography(
  credits: TmdbPersonCredits | null | undefined,
  hideAdult: boolean
): { movies: TmdbPersonCredit[]; shows: TmdbPersonCredit[]; featured: TmdbPersonCredit | null } {
  if (!credits) return { movies: [], shows: [], featured: null };
  const seen = new Set<string>();
  const merged: TmdbPersonCredit[] = [];
  for (const credit of [...(credits.cast ?? []), ...(credits.crew ?? [])]) {
    const kind = credit.media_type === "tv" ? "tv" : credit.media_type === "movie" ? "movie" : null;
    if (!kind || !credit.id) continue;
    const key = `${kind}:${credit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...credit, media_type: kind });
  }
  const cleaned = withoutAdultTitles(merged, hideAdult).sort((a, b) => creditScore(b) - creditScore(a));
  const movies = cleaned.filter((c) => c.media_type === "movie").slice(0, FILMOGRAPHY_LIMIT);
  const shows = cleaned.filter((c) => c.media_type === "tv").slice(0, FILMOGRAPHY_LIMIT);

  const castSeen = new Set<string>();
  const castOnly: TmdbPersonCredit[] = [];
  for (const credit of credits.cast ?? []) {
    const kind =
      credit.media_type === "tv" ? "tv" : credit.media_type === "movie" ? "movie" : null;
    if (!kind || !credit.id) continue;
    const key = `${kind}:${credit.id}`;
    if (castSeen.has(key)) continue;
    castSeen.add(key);
    castOnly.push({ ...credit, media_type: kind });
  }
  const featuredCast = withoutAdultTitles(castOnly, hideAdult).sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)
  );
  const featured = featuredCast.find((c) => c.poster_path) ?? featuredCast[0] ?? null;
  return { movies, shows, featured };
}

export function PersonView({ id, initialPerson, initialCredits }: Props) {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const hideAdult = useHideAdult();
  const [bioOpen, setBioOpen] = useState(false);

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

  const personQuery = useQuery({
    queryKey: ["tmdb", "person", id],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/person/${id}`);
      if (!res.ok) {
        const err = new Error(
          res.status === 404 ? "This person isn't in the catalog" : "Failed to load"
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<TmdbPerson>;
    },
    initialData: initialPerson ?? undefined,
    enabled: Number.isFinite(id) && id > 0,
  });

  const creditsQuery = useQuery({
    queryKey: ["tmdb", "person", id, "credits"],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/person/${id}/combined_credits`);
      if (!res.ok) return { id, cast: [], crew: [] } as TmdbPersonCredits;
      return res.json() as Promise<TmdbPersonCredits>;
    },
    initialData: initialCredits ?? undefined,
    enabled: Number.isFinite(id) && id > 0,
  });

  const person = personQuery.data;
  const { movies, shows, featured } = useMemo(
    () => collectFilmography(creditsQuery.data, hideAdult),
    [creditsQuery.data, hideAdult]
  );

  if (personQuery.isLoading && !person) {
    return (
      <div className="min-h-screen px-4 pb-12 pt-24 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 md:flex-row">
          <div className="h-40 w-40 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-3">
            <div className="h-8 w-56 max-w-full animate-pulse rounded-lg bg-muted" />
            <div className="h-4 w-full max-w-xl animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  if (personQuery.isError || !person) {
    return (
      <div className="min-h-screen px-4 pt-24 sm:px-6 lg:px-8">
        <PersonError onRetry={() => void personQuery.refetch()} />
      </div>
    );
  }

  const photo = tmdbImageUrl(person.profile_path, "original");
  const years = lifespan(person);
  const bio = person.biography?.trim() ?? "";
  const bioLong = bio.length > BIO_CLAMP;
  const bioText = bioOpen || !bioLong ? bio : `${bio.slice(0, BIO_CLAMP).trimEnd()}…`;
  const initials = person.name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen pb-12 pt-20">
      <motion.div
        className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionView}
      >
        <button
          type="button"
          onClick={() => {
            if (typeof window !== "undefined" && window.history.length > 1) {
              window.history.back();
              return;
            }
            navigate("/");
          }}
          className="mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <header
          data-tv-safe
          className="flex flex-col gap-6 rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl md:flex-row md:items-start"
        >
          <div className="relative h-40 w-40 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-white/15">
            {photo ? (
              <img src={photo} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-muted-foreground">
                {initials}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{person.name}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/70">
              {person.known_for_department ? (
                <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-white/80">
                  {person.known_for_department}
                </span>
              ) : null}
              {years ? (
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" aria-hidden />
                  {years}
                </span>
              ) : null}
              {person.place_of_birth ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                  {person.place_of_birth}
                </span>
              ) : null}
            </div>

            {bio ? (
              <div className="mt-4 max-w-2xl">
                <p className="text-sm leading-relaxed text-white/80">{bioText}</p>
                {bioLong ? (
                  <button
                    type="button"
                    onClick={() => setBioOpen((open) => !open)}
                    className="mt-2 text-sm font-medium text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {bioOpen ? "Show less" : "Read more"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {featured ? (
              <div className="mt-6">
                <Button
                  type="button"
                  size="lg"
                  onClick={() =>
                    navigate(
                      watchHref(
                        featured,
                        featured.media_type === "tv"
                          ? resumeTvEpisode(progressList, featured.id)
                          : null
                      )
                    )
                  }
                  className="rounded-full border-0 bg-white px-6 font-semibold text-[#111] hover:bg-white/85"
                >
                  <Play className="mr-1 h-4 w-4 fill-current" aria-hidden />
                  Play {creditTitle(featured)}
                  {creditYear(featured) ? ` (${creditYear(featured)})` : ""}
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="mt-10 space-y-10">
          {movies.length ? (
            <motion.div variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }} initial="hidden" animate="show" transition={transitionContent}>
              <MovieRow title="Movies">
                {movies.map((credit) => (
                  <MovieCard
                    key={`movie-${credit.id}`}
                    movie={{
                      id: credit.id,
                      title: creditTitle(credit),
                      poster_path: credit.poster_path,
                      backdrop_path: credit.backdrop_path,
                      release_date: credit.release_date,
                      vote_average: credit.vote_average,
                      media_type: "movie",
                      adult: credit.adult,
                    }}
                    forceMediaType="movie"
                  />
                ))}
              </MovieRow>
            </motion.div>
          ) : null}

          {shows.length ? (
            <motion.div variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }} initial="hidden" animate="show" transition={transitionContent}>
              <MovieRow title="Shows">
                {shows.map((credit) => (
                  <MovieCard
                    key={`tv-${credit.id}`}
                    movie={{
                      id: credit.id,
                      title: creditTitle(credit),
                      name: credit.name,
                      poster_path: credit.poster_path,
                      backdrop_path: credit.backdrop_path,
                      first_air_date: credit.first_air_date,
                      vote_average: credit.vote_average,
                      media_type: "tv",
                      adult: credit.adult,
                    }}
                    forceMediaType="tv"
                  />
                ))}
              </MovieRow>
            </motion.div>
          ) : null}

          {!movies.length && !shows.length && !creditsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">No filmography in the catalog yet.</p>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}
