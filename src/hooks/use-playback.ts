"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import { pickDefaultSource } from "@/lib/playback/source-quality";
import { getPreferredQualityHeight } from "@/lib/player-preferences";
import {
  getMemPlayback,
  playbackMemKey,
} from "@/lib/playback-preresolve";

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
  noCache?: boolean
): Promise<PlaybackResponse> {
  const params = new URLSearchParams();
  if (mediaType === "tv") {
    // Always send S/E — scrapers reject TV without them (default S1E1).
    params.set("season", String(season && season > 0 ? season : 1));
    params.set("episode", String(episode && episode > 0 ? episode : 1));
  }
  if (fast) params.set("fast", "1");
  if (noCache) params.set("nocache", "1");
  // Settings preferred quality → scraper ranking (Change 3).
  try {
    const qh = getPreferredQualityHeight();
    params.set("qualityHint", qh === "auto" ? "1080" : String(qh));
  } catch {
    params.set("qualityHint", "1080");
  }

  const res = await fetch(`/api/playback/${mediaType}/${tmdbId}?${params.toString()}`, {
    signal: AbortSignal.timeout(fast ? CLIENT_FAST_TIMEOUT_MS : CLIENT_FULL_TIMEOUT_MS),
  });
  const json = (await res.json()) as PlaybackResponse;
  if (!res.ok) throw new Error(json.message || "Failed to resolve playback");
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

  const byId = new Map<string, PlaybackSource>();
  for (const s of fast?.sources ?? []) byId.set(s.id, s);
  for (const s of full?.sources ?? []) {
    const existing = byId.get(s.id);
    if (!existing) {
      byId.set(s.id, s);
      continue;
    }
    // Keep stable proxy URL from first sighting; attach/update measured probe +
    // real quality capture from full (fast never quality-probes — TTFF-critical).
    const patch: Partial<PlaybackSource> = {};
    if (s.probe != null) patch.probe = s.probe;
    if (s.maxHeight != null) patch.maxHeight = s.maxHeight;
    if (s.ladder != null && s.ladder.length) patch.ladder = s.ladder;
    if (s.type) patch.type = s.type;
    if (s.qualitySource) patch.qualitySource = s.qualitySource;
    if (s.verified !== undefined) patch.verified = s.verified;
    if (Object.keys(patch).length) {
      byId.set(s.id, { ...existing, ...patch });
    }
  }

  const mergedSources =
    byId.size > 0 ? Array.from(byId.values()) : (base.sources ?? []);
  const streamUrlStillValid =
    !!base.streamUrl && mergedSources.some((s) => s.url === base.streamUrl);
  // Prefer multi-rung HD when re-defaulting streamUrl (same policy as player).
  let heightPref: "auto" | number = 1080;
  try {
    heightPref = getPreferredQualityHeight();
  } catch {
    heightPref = 1080;
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
  /** Only `retryFull()` may force nocache on the full scrape path. */
  const forceNoCacheRef = useRef(false);

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
    queryFn: () => fetchPlayback(args.mediaType, args.tmdbId, args.season, args.episode, true),
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
    queryFn: () => {
      const noCache = forceNoCacheRef.current;
      forceNoCacheRef.current = false;
      return fetchPlayback(
        args.mediaType,
        args.tmdbId,
        args.season,
        args.episode,
        false,
        noCache
      );
    },
    // Fires in parallel with `fast` (not gated on it settling) — first usable
    // result wins; see mergePlaybackResponses / fullStillOpen below.
    enabled: canFetch,
    retry: 1,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const mergedCount = Math.max(
        fast.data?.sources?.length ?? 0,
        query.state.data?.sources?.length ?? 0
      );
      const stillPartial =
        Boolean(query.state.data?.partial) || Boolean(fast.data?.partial);
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

  /** Full nocache re-resolve — resets both progressive queries. */
  const retryFull = useCallback(async () => {
    forceNoCacheRef.current = true;
    pollStartedAtRef.current = null;
    setDiscoveryWallHit(false);
    setSoftMissWallHit(false);
    const prefix = ["playback", args.mediaType, args.tmdbId, args.season, args.episode] as const;
    await qc.resetQueries({ queryKey: [...prefix] });
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
