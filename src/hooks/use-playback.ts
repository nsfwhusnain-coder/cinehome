"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { MediaType, PlaybackResponse } from "@/lib/playback/types";
import {
  isSourcePlayableHere,
  pickDefaultSource,
} from "@/lib/playback/source-quality";
import { mergeProgressivePlaybackSources } from "@/lib/playback/merge-sources";
import {
  getPreferredQualityHeight,
  syncProfilePlaybackPreferences,
} from "@/lib/player-preferences";
import {
  getMemPlayback,
  playbackMemKey,
} from "@/lib/playback-preresolve";
import {
  isPlaybackRateLimited,
  PlaybackRequestError,
  shouldRetryPlaybackRequest,
} from "@/lib/playback/request-error";
import { progressivePollInterval } from "@/lib/playback/progressive-poll";

interface Args {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  enabled?: boolean;
  prefetch?: boolean;
}

export function playbackQueryKey(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  fast?: boolean
) {
  return ["playback", mediaType, tmdbId, season, episode, fast ? "fast" : "full"] as const;
}

export function playbackRecoveryQueryKey(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number
) {
  return [
    "playback",
    mediaType,
    tmdbId,
    season,
    episode,
    "recovery",
  ] as const;
}

/** Match server scraper budgets — never hang UX on Playwright. */
const CLIENT_FAST_TIMEOUT_MS = 8_000;
const CLIENT_FULL_TIMEOUT_MS = 30_000;

/** Consume TanStack's cancellation signal without giving up the request wall. */
function playbackRequestSignal(
  timeoutMs: number,
  querySignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!querySignal) return timeoutSignal;
  if (querySignal.aborted) return querySignal;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  timeoutSignal.addEventListener("abort", abort, { once: true });
  querySignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function fetchPlayback(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  fast?: boolean,
  querySignal?: AbortSignal,
  recoveryRefresh?: boolean
): Promise<PlaybackResponse> {
  const params = new URLSearchParams();
  if (mediaType === "tv") {
    // Always send S/E — scrapers reject TV without them (default S1E1).
    params.set("season", String(season && season > 0 ? season : 1));
    params.set("episode", String(episode && episode > 0 ? episode : 1));
  }
  if (fast) params.set("fast", "1");
  if (recoveryRefresh) params.set("refresh", "1");
  // Settings preferred quality → scraper ranking (Change 3).
  try {
    const qh = getPreferredQualityHeight();
    params.set("qualityHint", String(qh));
  } catch {
    params.set("qualityHint", "auto");
  }

  const res = await fetch(`/api/playback/${mediaType}/${tmdbId}?${params.toString()}`, {
    cache: "no-store",
    signal: playbackRequestSignal(
      fast ? CLIENT_FAST_TIMEOUT_MS : CLIENT_FULL_TIMEOUT_MS,
      querySignal
    ),
  });
  const json = (await res.json()) as PlaybackResponse & {
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new PlaybackRequestError(
      json.error || json.message || "Failed to resolve playback",
      res.status
    );
  }
  if (json.preferences) syncProfilePlaybackPreferences(json.preferences);
  return json;
}

/**
 * Resolve a fresh signed roster outside the ordinary full query.
 *
 * Recovery cannot be a boolean consumed by the ordinary query function:
 * TanStack may reuse an already-running ordinary promise, and a query retry
 * invokes the function again after any one-shot flag has been cleared. A
 * dedicated key makes recovery single-flight while ensuring every retry is a
 * cache-bypassing request. Publishing the result into both ordinary caches
 * also prevents a stale fast response from resurrecting an expired URL.
 */
export async function recoverPlaybackRoster(
  qc: QueryClient,
  {
    mediaType,
    tmdbId,
    season,
    episode,
  }: Pick<Args, "mediaType" | "tmdbId" | "season" | "episode">
): Promise<PlaybackResponse> {
  const fullKey = playbackQueryKey(
    mediaType,
    tmdbId,
    season,
    episode,
    false
  );
  const fastKey = playbackQueryKey(
    mediaType,
    tmdbId,
    season,
    episode,
    true
  );
  const recoveryKey = playbackRecoveryQueryKey(
    mediaType,
    tmdbId,
    season,
    episode
  );

  // Abort older ordinary resolves before recovery starts. fetchPlayback
  // consumes TanStack's signal, so those requests cannot land while recovery
  // is acquiring ownership.
  await Promise.all([
    qc.cancelQueries({ queryKey: fullKey, exact: true }),
    qc.cancelQueries({ queryKey: fastKey, exact: true }),
  ]);

  try {
    const recovered = await qc.fetchQuery({
      queryKey: recoveryKey,
      queryFn: ({ signal }) =>
        fetchPlayback(
          mediaType,
          tmdbId,
          season,
          episode,
          false,
          signal,
          true
        ),
      retry: shouldRetryPlaybackRequest,
      retryDelay: 250,
      staleTime: 0,
      gcTime: 0,
    });

    // An interval/observer may have started another ordinary request during a
    // long resolver call. Revoke both once more at the publication boundary;
    // after these awaited cancellations, the synchronous writes below are the
    // sole authoritative generation.
    await Promise.all([
      qc.cancelQueries({ queryKey: fullKey, exact: true }),
      qc.cancelQueries({ queryKey: fastKey, exact: true }),
    ]);
    qc.setQueryData(fullKey, recovered);
    qc.setQueryData(fastKey, recovered);
    return recovered;
  } finally {
    // No observer owns this transport-only key. Removing it makes a later,
    // deliberate recovery issue a new request while concurrent callers still
    // share the in-flight promise above.
    qc.removeQueries({ queryKey: recoveryKey, exact: true });
  }
}

/**
 * After this many ms with at least one source, stop advertising "searching for more"
 * even if the scraper still marks partial (Playwright bg). Overlay must not hang minutes.
 */
export const DISCOVERY_UI_WALL_MS = 18_000;
/** Soft-miss without any source: hard-stop progressive loading after this. */
export const SOFT_MISS_WALL_MS = 25_000;

function hasPlayableSources(resp?: PlaybackResponse): boolean {
  return Boolean(resp?.sources?.length || resp?.streamUrl);
}

function usableSourceCount(resp?: PlaybackResponse): number {
  return (resp?.sources ?? []).filter(
    (source) =>
      source.verified !== false &&
      source.probe?.ok !== false &&
      isSourcePlayableHere(source)
  ).length;
}

/** Keep proxy URLs stable for sources already playing; only append new servers. */
export function mergePlaybackResponses(
  fast?: PlaybackResponse,
  full?: PlaybackResponse,
  fullStillOpen?: boolean
): PlaybackResponse | undefined {
  // Soft-miss: fast empty/error with no full yet — leave undefined so UI stays resolving.
  if (!hasPlayableSources(fast) && !full) return undefined;

  // A recovery generation deliberately invalidated every previously signed
  // URL. It is authoritative even when it returns an empty partial roster;
  // falling back to fast here resurrects the exact stale URL being recovered.
  const recoveryFull = full?.refreshNonce != null;
  const base = recoveryFull
    ? full
    : hasPlayableSources(fast)
      ? fast!
      : hasPlayableSources(full)
        ? full!
        : full ?? fast;

  if (!base) return undefined;
  if (!hasPlayableSources(base)) {
    // Soft-miss while full is open / still progressive. Once full has settled,
    // only full.partial counts (ignore stale fast soft-miss partial).
    const stillPartial =
      Boolean(fullStillOpen) ||
      (full ? Boolean(full.partial) : Boolean(fast?.partial));
    return {
      status: "error",
      // No message while partial — UI shows calm loading, not a red error.
      message: stillPartial
        ? undefined
        : (full?.message ?? fast?.message ?? "No stream available"),
      sources: [],
      providerId: full?.providerId ?? fast?.providerId,
      partial: stillPartial || undefined,
      preferences: full?.preferences ?? fast?.preferences,
      refreshNonce: full?.refreshNonce,
    };
  }

  const mergedSources = mergeProgressivePlaybackSources(
    recoveryFull ? [] : fast?.sources,
    full?.sources,
    recoveryFull
  );
  const streamUrlStillValid =
    !!base.streamUrl && mergedSources.some((s) => s.url === base.streamUrl);
  // Prefer multi-rung HD when re-defaulting streamUrl (same policy as player).
  const profilePreferences =
    full?.preferences ?? fast?.preferences ?? base.preferences;
  let heightPref: "auto" | number =
    profilePreferences?.playbackQuality ?? "auto";
  if (!profilePreferences) {
    try {
      heightPref = getPreferredQualityHeight();
    } catch {
      heightPref = "auto";
    }
  }
  const defaultSource = pickDefaultSource(mergedSources, null, heightPref);

  // Once full has returned, prefer its partial flag so fast's soft-miss partial doesn't stick forever.
  const partial = full
    ? Boolean(full.partial || fullStillOpen)
    : Boolean(fullStillOpen || fast?.partial);

  return {
    ...base,
    status: "available",
    sources: mergedSources,
    streamUrl: streamUrlStillValid ? base.streamUrl : (defaultSource?.url ?? base.streamUrl),
    partial: partial || undefined,
    preferences: profilePreferences,
    refreshNonce: full?.refreshNonce ?? fast?.refreshNonce,
  };
}

export function usePlayback({ tmdbId, mediaType, season, episode, enabled = true, prefetch = false }: Args) {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const canFetch = enabled && !!session;

  const query = useQuery({
    queryKey: playbackQueryKey(mediaType, tmdbId, season, episode, prefetch),
    queryFn: ({ signal }) =>
      fetchPlayback(mediaType, tmdbId, season, episode, prefetch, signal),
    enabled: canFetch,
    retry: prefetch ? 1 : false,
    staleTime: prefetch ? 5 * 60 * 1000 : 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!canFetch || !prefetch || query.isSuccess) return;
    const fullKey = playbackQueryKey(mediaType, tmdbId, season, episode, false);
    const timer = setTimeout(() => {
      qc.prefetchQuery({
        queryKey: fullKey,
        queryFn: ({ signal }) =>
          fetchPlayback(mediaType, tmdbId, season, episode, false, signal),
        staleTime: 10 * 60 * 1000,
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [canFetch, prefetch, query.isSuccess, mediaType, tmdbId, season, episode, qc]);

  return { data: query.data, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}

export function usePrefetchPlayback(args: Omit<Args, "enabled" | "prefetch">) {
  return usePlayback({ ...args, enabled: true, prefetch: true });
}

/** Watch page: fast sources first, full scrape in background with gentle source polling. */
export function useWatchPlayback(args: Omit<Args, "enabled" | "prefetch"> & { enabled?: boolean }) {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const canFetch = (args.enabled ?? true) && !!session;
  // Hero/detail hover preresolve warms client memory — seed RQ so first paint skips cold wait.
  const memSeed = useMemo((): PlaybackResponse | undefined => {
    if (typeof window === "undefined") return undefined;
    const key = playbackMemKey(args.mediaType, args.tmdbId, args.season, args.episode);
    const raw = getMemPlayback(key);
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as PlaybackResponse;
    if (!hasPlayableSources(r)) return undefined;
    return r;
  }, [args.mediaType, args.tmdbId, args.season, args.episode]);

  const fast = useQuery({
    queryKey: playbackQueryKey(args.mediaType, args.tmdbId, args.season, args.episode, true),
    queryFn: ({ signal }) =>
      fetchPlayback(
        args.mediaType,
        args.tmdbId,
        args.season,
        args.episode,
        true,
        signal
      ),
    enabled: canFetch,
    // No retry: full now fires in parallel (not gated on fast settling), so a slow/
    // failed fast pass no longer delays full — retrying it here would only add up
    // to another 8s wait for a result full is likely to supersede anyway.
    retry: false,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    ...(memSeed ? { initialData: memSeed, initialDataUpdatedAt: Date.now() } : {}),
  });

  const pollStartedAtRef = useRef<number | null>(null);

  const full = useQuery({
    queryKey: playbackQueryKey(args.mediaType, args.tmdbId, args.season, args.episode, false),
    queryFn: ({ signal }) =>
      fetchPlayback(
        args.mediaType,
        args.tmdbId,
        args.season,
        args.episode,
        false,
        signal
      ),
    // Fires in parallel with `fast` (not gated on it settling) — first usable
    // result wins; see mergePlaybackResponses / fullStillOpen below.
    enabled: canFetch,
    retry: shouldRetryPlaybackRequest,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      // Once full has measured the roster, its healthy count is authoritative.
      // A large fast roster of unprobed/dead URLs must not stop polling before
      // a late healthy provider arrives.
      const mergedCount = query.state.data
        ? usableSourceCount(query.state.data)
        : usableSourceCount(fast.data);
      const stillPartial = query.state.data
        ? Boolean(query.state.data.partial)
        : Boolean(fast.data?.partial);
      const hasAuthoritativeData = Boolean(query.state.data);
      const fetching = query.state.fetchStatus === "fetching";
      if (hasAuthoritativeData && !fetching && pollStartedAtRef.current == null) {
        pollStartedAtRef.current = Date.now();
      }
      return progressivePollInterval({
        rateLimited: isPlaybackRateLimited(query.state.error),
        hasAuthoritativeData,
        fetching,
        partial: stillPartial,
        usableSourceCount: mergedCount,
        extraFetches: Math.max(0, query.state.dataUpdateCount - 1),
        elapsedMs:
          pollStartedAtRef.current == null
            ? 0
            : Date.now() - pollStartedAtRef.current,
      });
    },
  });

  // full runs independently of fast now (parallel, not serial) — "still open" just
  // means full itself hasn't completed a first attempt yet.
  const fullStillOpen =
    canFetch && (full.isLoading || full.isFetching || !full.isFetched);

  const data = useMemo(
    () => mergePlaybackResponses(fast.data, full.data, fullStillOpen),
    [fast.data, full.data, fullStillOpen]
  );

  const hasSources = hasPlayableSources(data);

  // Force re-renders when discovery walls elapse so "searching for more" clears.
  const [discoveryWallHit, setDiscoveryWallHit] = useState(false);
  const [softMissWallHit, setSoftMissWallHit] = useState(false);

  useEffect(() => {
    if (!canFetch) {
      pollStartedAtRef.current = null;
      setDiscoveryWallHit(false);
      setSoftMissWallHit(false);
      return;
    }
    const active = fast.isFetching || full.isFetching || hasSources || fast.isFetched || full.isFetched;
    if (!active) return;
    if (pollStartedAtRef.current == null) {
      pollStartedAtRef.current = Date.now();
    }
    const started = pollStartedAtRef.current;
    const t1 = window.setTimeout(() => setDiscoveryWallHit(true), Math.max(0, DISCOVERY_UI_WALL_MS - (Date.now() - started)));
    const t2 = window.setTimeout(() => setSoftMissWallHit(true), Math.max(0, SOFT_MISS_WALL_MS - (Date.now() - started)));
    // If already past wall (strict mode remount), apply immediately.
    if (Date.now() - started >= DISCOVERY_UI_WALL_MS) setDiscoveryWallHit(true);
    if (Date.now() - started >= SOFT_MISS_WALL_MS) setSoftMissWallHit(true);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    canFetch,
    args.mediaType,
    args.tmdbId,
    args.season,
    args.episode,
    fast.isFetching,
    full.isFetching,
    fast.isFetched,
    full.isFetched,
    hasSources,
  ]);

  // Scraper partial after full settled — ignore for UI once we have sources + wall.
  const rawPartial = full.isFetched
    ? Boolean(full.data?.partial)
    : Boolean(data?.partial || fast.data?.partial);
  const sourceN = data?.sources?.length ?? 0;
  const partialForUi =
    rawPartial &&
    !discoveryWallHit &&
    !(hasSources && full.isFetched && sourceN >= 2);

  // Once full is fetched, only full.partial (within wall) keeps progressive open.
  const progressiveOpen =
    (fullStillOpen && !softMissWallHit) ||
    (partialForUi && !hasSources) ||
    (partialForUi && hasSources && !discoveryWallHit);

  // Fast empty/error while full still in flight or partial enrich open — not hard error.
  const isSoftMiss =
    canFetch &&
    !hasSources &&
    !fast.isLoading &&
    !softMissWallHit &&
    (fast.isError ||
      fast.data?.status === "error" ||
      fast.data?.partial === true ||
      (fast.isSuccess && !hasPlayableSources(fast.data))) &&
    progressiveOpen;

  const isLoading =
    canFetch &&
    !hasSources &&
    (fast.isLoading ||
      full.isLoading ||
      ((fast.isSuccess || fast.isError) && !full.isFetched && !softMissWallHit) ||
      isSoftMiss ||
      (progressiveOpen && !hasSources));

  const isFetching = fast.isFetching || full.isFetching;

  // Background enrich for dock only — never keep hunting overlay forever on partial.
  const isEnriching =
    hasSources &&
    !discoveryWallHit &&
    (full.isFetching ||
      full.isLoading ||
      partialForUi ||
      (!full.isFetched && (fast.isSuccess || fast.isError)));

  // Suppress hard errors while soft-miss / still resolving / partial open.
  const error =
    isLoading || isSoftMiss || (progressiveOpen && !hasSources) || hasSources
      ? null
      : (fast.error ?? full.error);

  /**
   * Full recovery resolve. Refetch keeps the last full roster visible while
   * fresh signed URLs arrive; resetting the query used to erase the selected
   * source and silently switch servers before recovery owned the outcome.
   */
  const retryFull = useCallback(async () => {
    pollStartedAtRef.current = null;
    setDiscoveryWallHit(false);
    setSoftMissWallHit(false);
    await recoverPlaybackRoster(qc, {
      mediaType: args.mediaType,
      tmdbId: args.tmdbId,
      season: args.season,
      episode: args.episode,
    });
  }, [
    qc,
    args.mediaType,
    args.tmdbId,
    args.season,
    args.episode,
  ]);

  return {
    data,
    isLoading,
    isFetching,
    isSoftMiss,
    isEnriching,
    sourceCount: data?.sources?.length ?? 0,
    error,
    /** @deprecated prefer retryFull — kept for callers that only need a full refetch */
    refetch: full.refetch,
    retryFull,
  };
}
