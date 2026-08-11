"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  getMemPlaybackSeed,
  playbackMemKey,
} from "@/lib/playback-preresolve";
import { usableCachedPlayback } from "@/lib/playback/cache-age";
import {
  isPlaybackRateLimited,
  PlaybackRequestError,
  shouldRetryPlaybackRequest,
} from "@/lib/playback/request-error";

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

/** Match server scraper budgets — never hang UX on Playwright. */
const CLIENT_FAST_TIMEOUT_MS = 8_000;
const CLIENT_FULL_TIMEOUT_MS = 30_000;

async function fetchPlayback(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  fast?: boolean,
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
    signal: AbortSignal.timeout(fast ? CLIENT_FAST_TIMEOUT_MS : CLIENT_FULL_TIMEOUT_MS),
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

/** Early polls while roster is thin. */
const POLL_INTERVAL_BASE_MS = 2_000;
/** Back off once we have a few playable sources. */
const POLL_INTERVAL_LATER_MS = 5_000;
/** Cap progressive re-fetches (was 12). */
const MAX_SOURCE_POLL_REFETCHES = 5;
/** Aggressive 2s polls only while below this count. */
const SOURCE_POLL_AGGRESSIVE_UNTIL = 3;
/** Stop hunting once roster is healthy (3–5 band). */
const SOURCE_POLL_TARGET = 4;
/** Wall-clock budget for progressive hunting / refetchInterval. */
const POLL_WALL_MS = 30_000;
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
function mergePlaybackResponses(
  fast?: PlaybackResponse,
  full?: PlaybackResponse,
  fullStillOpen?: boolean
): PlaybackResponse | undefined {
  // Soft-miss: fast empty/error with no full yet — leave undefined so UI stays resolving.
  if (!hasPlayableSources(fast) && !full) return undefined;

  const base = hasPlayableSources(fast)
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
    };
  }

  const mergedSources = mergeProgressivePlaybackSources(
    fast?.sources,
    full?.sources,
    full?.refreshNonce != null
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
    queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, prefetch),
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
        queryFn: () => fetchPlayback(mediaType, tmdbId, season, episode, false),
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
  /** Only `retryFull()` may force a bounded recovery refresh. */
  const forceRefreshRef = useRef(false);

  // Hero/detail hover preresolve seeds the shell, but remains stale so a fresh
  // signed URL is fetched immediately instead of trusting the memory age.
  const memSeed = useMemo((): {
    data: PlaybackResponse;
    updatedAt: number;
  } | undefined => {
    if (typeof window === "undefined") return undefined;
    const key = playbackMemKey(args.mediaType, args.tmdbId, args.season, args.episode);
    const hit = getMemPlaybackSeed(key);
    if (!hit || typeof hit.data !== "object") return undefined;
    const r = hit.data as PlaybackResponse;
    if (!hasPlayableSources(r)) return undefined;
    return { data: r, updatedAt: hit.updatedAt };
  }, [args.mediaType, args.tmdbId, args.season, args.episode]);

  const fast = useQuery({
    queryKey: playbackQueryKey(args.mediaType, args.tmdbId, args.season, args.episode, true),
    queryFn: () => fetchPlayback(args.mediaType, args.tmdbId, args.season, args.episode, true),
    enabled: canFetch,
    // No retry: full now fires in parallel (not gated on fast settling), so a slow/
    // failed fast pass no longer delays full — retrying it here would only add up
    // to another 8s wait for a result full is likely to supersede anyway.
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    ...(memSeed
      ? { initialData: memSeed.data, initialDataUpdatedAt: memSeed.updatedAt }
      : {}),
  });

  const fastData = usableCachedPlayback(fast.data, fast.dataUpdatedAt);

  const pollStartedAtRef = useRef<number | null>(null);

  const full = useQuery({
    queryKey: playbackQueryKey(args.mediaType, args.tmdbId, args.season, args.episode, false),
    queryFn: () => {
      const recoveryRefresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      return fetchPlayback(
        args.mediaType,
        args.tmdbId,
        args.season,
        args.episode,
        false,
        recoveryRefresh
      );
    },
    // Fires in parallel with `fast` (not gated on it settling) — first usable
    // result wins; see mergePlaybackResponses / fullStillOpen below.
    enabled: canFetch,
    retry: shouldRetryPlaybackRequest,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      // A closed server bucket is authoritative. Retrying every 1–2 seconds
      // cannot enrich the roster and only adds load; manual exhausted-roster
      // recovery remains independently available.
      if (isPlaybackRateLimited(query.state.error)) return false;
      // Once full has measured the roster, its healthy count is authoritative.
      // A large fast roster of unprobed/dead URLs must not stop polling before
      // a late healthy provider arrives.
      const mergedCount = query.state.data
        ? usableSourceCount(query.state.data)
        : usableSourceCount(fastData);
      const stillPartial =
        Boolean(query.state.data?.partial) || Boolean(fastData?.partial);
      // Enough sources + complete → stop.
      if (mergedCount >= SOURCE_POLL_TARGET && !stillPartial) return false;
      // Healthy roster is enough even if scraper still marks partial (PW bg).
      if (mergedCount >= SOURCE_POLL_TARGET) return false;
      if (!query.state.data || query.state.fetchStatus === "fetching") return false;
      const extraFetches = query.state.dataUpdateCount - 1;
      if (extraFetches >= MAX_SOURCE_POLL_REFETCHES) return false;

      if (pollStartedAtRef.current == null) {
        pollStartedAtRef.current = Date.now();
      }
      if (Date.now() - pollStartedAtRef.current >= POLL_WALL_MS) return false;

      // 2s while thin roster; 5s once we have ≥3 sources or after early cycles.
      if (mergedCount < SOURCE_POLL_AGGRESSIVE_UNTIL && extraFetches < 3) {
        return POLL_INTERVAL_BASE_MS;
      }
      return POLL_INTERVAL_LATER_MS;
    },
  });

  // full runs independently of fast now (parallel, not serial) — "still open" just
  // means full itself hasn't completed a first attempt yet.
  const fullStillOpen =
    canFetch && (full.isLoading || full.isFetching || !full.isFetched);

  const data = useMemo(
    () => mergePlaybackResponses(fastData, full.data, fullStillOpen),
    [fastData, full.data, fullStillOpen]
  );

  const hasSources = hasPlayableSources(data);

  // Force re-renders when discovery walls elapse so "searching for more" clears.
  const [discoveryWallHit, setDiscoveryWallHit] = useState(false);
  const [softMissWallHit, setSoftMissWallHit] = useState(false);

  /**
   * Walls belong to one target. Clearing them during render off a key rather
   * than inside the effect also fixes a real staleness bug: the effect only
   * reset when fetching became impossible, so navigating straight from one
   * title to another carried "we already gave up looking" across to a roster
   * that had barely started resolving.
   */
  const wallTarget = canFetch
    ? `${args.mediaType}:${args.tmdbId}:${args.season ?? ""}:${args.episode ?? ""}`
    : null;
  const [wallsFor, setWallsFor] = useState<string | null>(null);
  if (wallTarget !== wallsFor) {
    setWallsFor(wallTarget);
    if (discoveryWallHit) setDiscoveryWallHit(false);
    if (softMissWallHit) setSoftMissWallHit(false);
  }

  useEffect(() => {
    if (!canFetch) {
      pollStartedAtRef.current = null;
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
    : Boolean(data?.partial || fastData?.partial);
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
      fastData?.status === "error" ||
      fastData?.partial === true ||
      (fast.isSuccess && !hasPlayableSources(fastData))) &&
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

  /** Full recovery resolve. Keep fast data visible while fresh URLs arrive. */
  const retryFull = useCallback(async () => {
    forceRefreshRef.current = true;
    pollStartedAtRef.current = null;
    setDiscoveryWallHit(false);
    setSoftMissWallHit(false);
    await qc.resetQueries({
      queryKey: playbackQueryKey(
        args.mediaType,
        args.tmdbId,
        args.season,
        args.episode,
        false
      ),
      exact: true,
    });
  }, [qc, args.mediaType, args.tmdbId, args.season, args.episode]);

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
