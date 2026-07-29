"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl, pickTitleLogoUrl, type TmdbImages } from "@/lib/tmdb";
import { useMounted } from "@/hooks/use-mounted";
import { VideoPlayer } from "@/components/video-player";
import { AlertCircle, Loader2, ExternalLink, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWatchPlayback } from "@/hooks/use-playback";
import { NoProvider } from "@/components/empty-states";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import type { PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import { sourceId } from "@/lib/playback/server-names";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Cancelable end-of-episode autoplay countdown (task 9). */
const NEXT_EPISODE_COUNTDOWN_S = 10;

interface Props {
  mediaType: "movie" | "tv";
  id: number;
  season?: number;
  episode?: number;
}

interface ProgressItem {
  tmdbId: number;
  mediaType: string;
  progress: number;
  position: number;
  duration: number;
  season?: number | null;
  episode?: number | null;
}

function toPlaybackSources(playback: PlaybackResponse | undefined): PlaybackSource[] {
  if (!playback?.sources?.length && !playback?.streamUrl) return [];
  if (playback.sources?.length) return playback.sources;
  const url = playback.streamUrl!;
  return [
    {
      id: sourceId("Stream", "HLS"),
      url,
      provider: playback.providerId ?? "Stream",
      quality: "auto",
      label: "HLS",
      type: url.includes(".m3u8") || url.includes("/playlist/")
        ? "hls"
        : url.includes(".mpd")
          ? "dash"
          : "hls",
    },
  ];
}

function playbackErrorMessage(
  playback: PlaybackResponse | undefined,
  err: Error | null,
  opts?: { suppress?: boolean }
): string | null {
  if (opts?.suppress) return null;
  // Progressive / soft-miss must never surface as a hard player error.
  if (playback?.partial) return null;
  if (err) {
    const msg = err.message || "";
    if (/no fast source/i.test(msg)) return null;
    return msg || "Something went wrong loading streams";
  }
  if (playback?.status === "error") {
    const msg = playback.message ?? "No stream available";
    if (/no fast source/i.test(msg)) return null;
    return msg;
  }
  return null;
}

interface SeasonMeta {
  season_number: number;
  episode_count: number;
}

function resolveNextEpisode(
  seasons: SeasonMeta[] | undefined,
  season: number,
  episode: number
): { season: number; episode: number } | null {
  // Soft fallback when seasons meta not loaded yet — prefer advancing in-season.
  if (!seasons?.length) {
    return { season, episode: episode + 1 };
  }
  // Regular seasons only for rollover (skip specials / S0).
  const regular = seasons.filter((s) => s.season_number > 0 && s.episode_count > 0);
  const current = regular.find((s) => s.season_number === season);
  const count = current?.episode_count ?? 0;
  if (count > 0 && episode < count) {
    return { season, episode: episode + 1 };
  }
  // Last ep of season → first ep of next regular season with content.
  const nextSeason = regular
    .filter((s) => s.season_number > season)
    .sort((a, b) => a.season_number - b.season_number)[0];
  if (nextSeason) {
    return { season: nextSeason.season_number, episode: 1 };
  }
  // End of series (or only specials remaining).
  return null;
}

/**
 * Full-viewport LordFlix watch page — player only, no info junk below.
 */
export function WatchView({ mediaType, id, season, episode }: Props) {
  const navigate = useNavigate();
  const router = useRouter();
  const mounted = useMounted();
  const { data: session } = useSession();
  const qc = useQueryClient();
  const [savedTime, setSavedTime] = useState(0);
  const [ended, setEnded] = useState(false);
  /** Always tagged with title/S/E so a flush never writes episode N's playhead onto episode N+1. */
  const lastProgressRef = useRef<{
    position: number;
    duration: number;
    tmdbId: number;
    mediaType: string;
    season: number;
    episode: number;
  } | null>(null);
  const saveGenerationRef = useRef(0);
  const resumeToastShown = useRef(false);

  // TV scrapers require season+episode. Default S1E1 when URL omits them.
  const tvSeason = mediaType === "tv" ? (season && season > 0 ? season : 1) : undefined;
  const tvEpisode = mediaType === "tv" ? (episode && episode > 0 ? episode : 1) : undefined;

  /**
   * Leave the player by popping history — do NOT push the detail URL.
   * Pushing detail on top of watch traps the next Back on the player:
   *   home → detail → watch → detail(pushed)  ⇒  Back = watch again.
   * With back(): home → detail → watch  ⇒  Back = detail  ⇒  Back = home.
   */
  const leaveWatch = useCallback(() => {
    if (typeof window !== "undefined") {
      const idx = (window.history.state as { idx?: number } | null)?.idx;
      if (typeof idx === "number" && idx > 0) {
        router.back();
        return;
      }
      try {
        if (
          document.referrer &&
          new URL(document.referrer).origin === window.location.origin
        ) {
          router.back();
          return;
        }
      } catch {
        /* ignore invalid referrer */
      }
    }
    router.replace(`/${mediaType}/${id}`);
  }, [router, mediaType, id]);

  const { data: meta } = useQuery({
    queryKey: ["tmdb", mediaType, id, "watch"],
    queryFn: async () => {
      const res = await fetch(
        mediaType === "movie"
          ? `/api/tmdb/movie/${id}?append_to_response=images`
          : `/api/tmdb/tv/${id}?append_to_response=images`
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: mounted,
  });

  const images = meta?.images as TmdbImages | undefined;

  const { data: progressList } = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressItem[];
      return res.json() as Promise<ProgressItem[]>;
    },
    enabled: mounted && !!session,
  });

  // Normalize TV URLs so history/share always include S/E
  useEffect(() => {
    if (!mounted || mediaType !== "tv") return;
    if (season != null && season > 0 && episode != null && episode > 0) return;
    router.replace(`/watch/tv/${id}?season=${tvSeason}&episode=${tvEpisode}`);
  }, [mounted, mediaType, id, season, episode, tvSeason, tvEpisode, router]);

  useEffect(() => {
    resumeToastShown.current = false;
    // Drop previous episode's playhead immediately — do not let flush/onProgress
    // write S1E1's timestamp onto S1E2 (next-episode / picker bug).
    lastProgressRef.current = null;
    saveGenerationRef.current += 1;
  }, [id, mediaType, tvSeason, tvEpisode]);

  useEffect(() => {
    // Always reset first so episode/title changes don't inherit prior resume time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedTime(0);
    const found = progressList?.find((p) => {
      if (Number(p.tmdbId) !== Number(id) || p.mediaType !== mediaType) return false;
      if (mediaType !== "tv") return true;
      // Movies use season/episode 0 in DB; TV must match the open episode.
      return Number(p.season) === Number(tvSeason) && Number(p.episode) === Number(tvEpisode);
    });
    if (found && found.progress > 0.02 && found.progress < 0.95 && found.duration > 0) {
      const fromPos = Number(found.position) || 0;
      const fromPct = (Number(found.progress) || 0) * (Number(found.duration) || 0);
      const t = fromPos > 5 ? fromPos : fromPct;
      if (t > 5) {
        setSavedTime(t);
      }
    }
  }, [progressList, id, mediaType, tvSeason, tvEpisode]);

  const {
    data: playback,
    isLoading: playbackLoading,
    isFetching: playbackFetching,
    isSoftMiss,
    isEnriching,
    sourceCount,
    retryFull,
    error: playbackError,
  } = useWatchPlayback({
    tmdbId: id,
    mediaType,
    season: tvSeason,
    episode: tvEpisode,
    enabled: mounted,
  });

  const playbackSources = toPlaybackSources(playback);
  // Soft-kept / probe-failed rows are switchable but not "found healthy" for hunting copy.
  const playableSourceCount = playbackSources.filter(
    (s) => s.verified !== false && s.probe?.ok !== false
  ).length;
  const sourcesLoading =
    mounted &&
    !!session &&
    playbackSources.length === 0 &&
    (playbackLoading || isSoftMiss || Boolean(playback?.partial));
  const sourcesError = playbackErrorMessage(playback, playbackError as Error | null, {
    // Soft-miss / progressive resolve must never paint a red hard error.
    suppress: sourcesLoading || isSoftMiss || Boolean(playback?.partial),
  });
  // Background enrich flag for dock pulse / chip text ONLY.
  // Playback starts on first source — this never blocks hasStream/play.
  const isDiscoveringSources =
    (isSoftMiss && playbackSources.length === 0) ||
    (isEnriching && playbackSources.length > 0) ||
    (playbackFetching && playbackSources.length === 0);

  const showPlayerShell = mounted && !!session;
  const baseTitle = meta?.title || meta?.name || playback?.title || "Untitled";
  const title =
    mediaType === "tv" && tvSeason != null && tvEpisode != null
      ? `${baseTitle} · S${tvSeason}E${tvEpisode}`
      : baseTitle;
  const blockedStatus =
    playback?.status === "not_configured" ||
    playback?.status === "external" ||
    playback?.status === "requestable";

  useEffect(() => {
    if (playbackSources.length > 0 && savedTime > 5 && !resumeToastShown.current) {
      resumeToastShown.current = true;
      // Top-center, short, non-blocking — never cover bottom player controls / gear.
      toast.success(`Resumed from ${formatTime(savedTime)}`, {
        position: "top-center",
        duration: 2200,
        className: "pointer-events-none",
      });
    }
  }, [playbackSources.length, savedTime]);

  const persistProgress = useCallback(
    async (e: {
      position: number;
      duration: number;
      progress?: number;
      tmdbId: number;
      mediaType: string;
      season: number;
      episode: number;
    }) => {
      if (!session || e.duration <= 0) return;
      if (e.mediaType === "tv" && (e.season < 1 || e.episode < 1)) return;

      // Drop stale saves from the previous episode after a switch.
      if (
        e.tmdbId !== id ||
        e.mediaType !== mediaType ||
        (mediaType === "tv" &&
          (e.season !== tvSeason || e.episode !== tvEpisode)) ||
        (mediaType === "movie" && (e.season !== 0 || e.episode !== 0))
      ) {
        return;
      }

      const generation = ++saveGenerationRef.current;
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: e.tmdbId,
          mediaType: e.mediaType,
          title,
          poster: meta?.poster_path ?? null,
          backdrop: meta?.backdrop_path ?? null,
          progress: e.progress ?? e.position / e.duration,
          position: e.position,
          duration: e.duration,
          season: e.mediaType === "tv" ? e.season : 0,
          episode: e.mediaType === "tv" ? e.episode : 0,
          providerId: playback?.providerId ?? null,
        }),
      });

      if (generation !== saveGenerationRef.current) return;
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ["progress"] });
      }
    },
    [session, id, mediaType, title, meta, tvSeason, tvEpisode, playback?.providerId, qc]
  );

  const flushProgress = useCallback(() => {
    const last = lastProgressRef.current;
    if (!last || last.duration <= 0) return;
    // Only flush if the snapshot still belongs to the episode on screen.
    if (
      last.tmdbId !== id ||
      last.mediaType !== mediaType ||
      (mediaType === "tv"
        ? last.season !== tvSeason || last.episode !== tvEpisode
        : last.season !== 0 || last.episode !== 0)
    ) {
      return;
    }
    void persistProgress(last);
  }, [persistProgress, id, mediaType, tvSeason, tvEpisode]);

  /**
   * Tab-close-safe flush (task 6): a plain `fetch` here gets cancelled by the
   * browser on unload before it ever leaves the page, silently dropping the
   * final resume position. `sendBeacon` (falling back to `fetch(keepalive)`)
   * survives page teardown. POST /api/progress just does `req.json()` — it
   * doesn't care about Content-Type — so a Blob typed `application/json`
   * parses the same as the regular fetch path; the route itself is untouched.
   */
  const flushProgressBeacon = useCallback(() => {
    const last = lastProgressRef.current;
    if (!session || !last || last.duration <= 0) return;
    if (
      last.tmdbId !== id ||
      last.mediaType !== mediaType ||
      (mediaType === "tv"
        ? last.season !== tvSeason || last.episode !== tvEpisode
        : last.season !== 0 || last.episode !== 0)
    ) {
      return;
    }

    const body = JSON.stringify({
      tmdbId: last.tmdbId,
      mediaType: last.mediaType,
      title,
      poster: meta?.poster_path ?? null,
      backdrop: meta?.backdrop_path ?? null,
      progress: last.position / last.duration,
      position: last.position,
      duration: last.duration,
      season: last.mediaType === "tv" ? last.season : 0,
      episode: last.mediaType === "tv" ? last.episode : 0,
      providerId: playback?.providerId ?? null,
    });

    let sent = false;
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      sent = navigator.sendBeacon("/api/progress", blob);
    }
    if (!sent) {
      void fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        /* page is closing — nothing left to surface this to */
      });
    }
  }, [session, id, mediaType, title, meta, tvSeason, tvEpisode, playback?.providerId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushProgressBeacon();
    };
    const onPageHide = () => flushProgressBeacon();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Unmount here means an in-app navigation (tab stays open) — the
      // regular fetch path is fine and keeps the progress-query invalidation.
      flushProgress();
    };
  }, [flushProgress, flushProgressBeacon]);

  /**
   * useCallback (task 8): the player reads this via a ref internally so it
   * never re-attaches its media listeners on a new identity, but keeping this
   * stable too means it isn't recreated needlessly on every WatchView render
   * (e.g. every progressive-enrich poll tick).
   */
  const onProgress = useCallback(
    (current: number, duration: number) => {
      if (duration <= 0) return;
      const seasonKey = mediaType === "tv" ? (tvSeason ?? 0) : 0;
      const episodeKey = mediaType === "tv" ? (tvEpisode ?? 0) : 0;
      lastProgressRef.current = {
        position: current,
        duration,
        tmdbId: id,
        mediaType,
        season: seasonKey,
        episode: episodeKey,
      };
      void persistProgress({
        position: current,
        duration,
        tmdbId: id,
        mediaType,
        season: seasonKey,
        episode: episodeKey,
      });
    },
    [id, mediaType, tvSeason, tvEpisode, persistProgress]
  );

  const onEnded = useCallback(async () => {
    if (!session) return;
    const generation = ++saveGenerationRef.current;
    const params = new URLSearchParams({
      tmdbId: String(id),
      mediaType,
    });
    if (mediaType === "tv" && tvSeason != null && tvEpisode != null) {
      params.set("season", String(tvSeason));
      params.set("episode", String(tvEpisode));
    }
    const res = await fetch(`/api/progress?${params}`, { method: "DELETE" });
    if (generation !== saveGenerationRef.current) return;
    lastProgressRef.current = null;
    if (res.ok) qc.invalidateQueries({ queryKey: ["progress"] });
    setEnded(true);
    toast.success("Finished! Marking as watched.");
  }, [session, id, mediaType, tvSeason, tvEpisode, qc]);

  // useMemo (task 8): resolveNextEpisode returns a fresh object literal every
  // call even when season/episode are unchanged — without memoizing, this
  // identity churn (on every WatchView render, e.g. progressive-enrich polls)
  // was one of the two causes forcing the player's media listeners to detach
  // and re-attach roughly every 2-5s.
  const nextEpisodeTarget = useMemo(
    () =>
      mediaType === "tv" && tvSeason != null && tvEpisode != null
        ? resolveNextEpisode(meta?.seasons as SeasonMeta[] | undefined, tvSeason, tvEpisode)
        : null,
    [mediaType, tvSeason, tvEpisode, meta?.seasons]
  );
  const hasNextEpisode = nextEpisodeTarget != null;

  const goToNextEpisode = useCallback(() => {
    if (!nextEpisodeTarget) return;
    // Flush current episode under its own identity, then hard-reset so next ep starts at 0.
    flushProgress();
    lastProgressRef.current = null;
    saveGenerationRef.current += 1;
    setEnded(false);
    setSavedTime(0);
    navigate(
      `/watch/tv/${id}?season=${nextEpisodeTarget.season}&episode=${nextEpisodeTarget.episode}`
    );
  }, [nextEpisodeTarget, flushProgress, navigate, id]);

  const selectEpisode = useCallback(
    (s: number, e: number) => {
      flushProgress();
      lastProgressRef.current = null;
      saveGenerationRef.current += 1;
      setEnded(false);
      setSavedTime(0);
      navigate(`/watch/tv/${id}?season=${s}&episode=${e}`);
    },
    [navigate, id, flushProgress]
  );

  const handleRequest = async () => {
    const endpoint = playback?.action?.requestEndpoint;
    if (!endpoint) return;
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) {
        toast.success("Request sent");
        void retryFull().catch(() => {
          toast.error("Fresh sources could not be loaded");
        });
      } else toast.error("Request failed");
    } catch {
      toast.error("Request failed");
    }
  };

  const backdrop = tmdbImageUrl(meta?.backdrop_path ?? playback?.poster, "w1280");

  // Full-bleed inside watch/layout — no max-width shell; bars only from object-fit:contain
  return (
    <div
      data-page="watch"
      className="relative m-0 h-full w-full max-w-none overflow-hidden bg-black p-0"
    >
      {!mounted ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-white/70" />
        </div>
      ) : !session ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-white/70">
          <User className="h-10 w-10 text-white" />
          <div className="text-sm font-medium">Sign in to start watching</div>
          <Button type="button" onClick={() => navigate("/login")} size="sm">
            Sign in
          </Button>
        </div>
      ) : blockedStatus ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-white">
          {playback?.status === "not_configured" ? (
            <NoProvider />
          ) : playback?.status === "external" ? (
            <>
              <ExternalLink className="h-10 w-10" />
              <div className="text-sm font-medium">Available on a paid service</div>
              {playback.action?.url && (
                <a href={playback.action.url} target="_blank" rel="noreferrer">
                  <Button type="button" size="sm">
                    {playback.action.label}
                  </Button>
                </a>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="h-10 w-10 text-amber-400" />
              <div className="text-sm font-medium">Not in your library</div>
              <Button
                type="button"
                size="sm"
                onClick={handleRequest}
                disabled={!playback?.action?.requestEndpoint}
              >
                {playback?.action?.label || "Request"}
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={leaveWatch}>
            Back
          </Button>
        </div>
      ) : showPlayerShell ? (
        <div className="absolute inset-0 h-full w-full">
          <VideoPlayer
            key={`${mediaType}-${id}-${tvSeason}-${tvEpisode}`}
            sources={playbackSources}
            sourcesLoading={sourcesLoading}
            sourcesError={sourcesError}
            onRetrySources={retryFull}
            isDiscoveringSources={isDiscoveringSources}
            profileQuality={playback?.preferences?.playbackQuality}
            refreshNonce={playback?.refreshNonce}
            sourceCount={
              playableSourceCount > 0
                ? playableSourceCount
                : sourceCount || playbackSources.length
            }
            poster={backdrop}
            title={title}
            mediaType={mediaType}
            initialTime={savedTime}
            onProgress={onProgress}
            onEnded={onEnded}
            hasNextEpisode={mediaType === "tv" && hasNextEpisode}
            onNextEpisode={goToNextEpisode}
            nextEpisodeTarget={nextEpisodeTarget}
            onBack={leaveWatch}
            tvId={mediaType === "tv" ? id : undefined}
            tmdbId={id}
            tvSeasons={
              mediaType === "tv"
                ? ((meta?.seasons as SeasonMeta[] | undefined) ?? [])
                    .filter((s) => s.season_number > 0)
                    .map((s) => ({
                      season_number: s.season_number,
                      name: `Season ${s.season_number}`,
                      episode_count: s.episode_count,
                    }))
                : undefined
            }
            tvSeason={tvSeason}
            tvEpisode={tvEpisode}
            onSelectEpisode={mediaType === "tv" ? selectEpisode : undefined}
          />
          {ended && mediaType === "tv" && nextEpisodeTarget && (
            <NextEpisodeCountdown
              key={`${nextEpisodeTarget.season}-${nextEpisodeTarget.episode}`}
              target={nextEpisodeTarget}
              currentSeason={tvSeason}
              onPlayNow={goToNextEpisode}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Cancelable end-of-episode autoplay countdown (task 9). Self-contained (own
 * ticking state) so mount/unmount — driven by the parent's `ended` + a
 * per-episode `key` — naturally resets the countdown for every new episode,
 * with no separate reset effect needed. Ticks via setTimeout callbacks
 * (state updated inside the timer callback, not synchronously in the effect
 * body) rather than a parent-owned interval + reset effect.
 */
function NextEpisodeCountdown({
  target,
  currentSeason,
  onPlayNow,
}: {
  target: { season: number; episode: number };
  currentSeason?: number;
  onPlayNow: () => void;
}) {
  const [remaining, setRemaining] = useState(NEXT_EPISODE_COUNTDOWN_S);
  const [cancelled, setCancelled] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (cancelled || remaining <= 0) {
      if (!cancelled && remaining <= 0 && !firedRef.current) {
        firedRef.current = true;
        onPlayNow();
      }
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining, cancelled, onPlayNow]);

  const playLabel =
    target.season !== currentSeason
      ? `Play S${target.season} E${target.episode}`
      : `Play Episode ${target.episode}`;

  return (
    <div className="absolute bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-white/10 bg-black/90 px-6 py-4 shadow-2xl">
      <div className="mb-2 text-center text-sm font-medium text-white">
        {cancelled ? "Up next" : `Next episode in ${remaining}…`}
      </div>
      <div className="flex items-center justify-center gap-2">
        {!cancelled && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setCancelled(true)}
            className="rounded-full"
          >
            Cancel
          </Button>
        )}
        <Button type="button" onClick={onPlayNow} className="rounded-full">
          {cancelled ? playLabel : "Play now"}
        </Button>
      </div>
    </div>
  );
}
