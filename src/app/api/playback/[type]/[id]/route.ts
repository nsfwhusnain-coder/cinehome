import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getProvider } from "@/lib/playback";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback";
import { isPlaybackFastPathEnabled } from "@/lib/feature-flags";
import {
  decideImmediateSource,
  type DecidePlaybackOptions,
} from "@/lib/playback/decide-playback";
import { remuxHasCapacity } from "@/lib/playback/remux-health";
import { buildFastDebridResponse } from "@/lib/playback/fast-debrid";
import { RateLimiter } from "@/lib/rate-limit";
import { getUserPlaybackPreferences } from "@/lib/profile-preferences.server";
import {
  consumesTitleResolveBudget,
  playbackRefreshMode,
} from "@/lib/playback/refresh-mode";
import { proxyRecoveryDebridSources } from "@/lib/playback/recovery-proxy";
import { consumePlaybackResolveBudget } from "@/lib/playback/resolve-budget";
import { stampSourceUrlTickets } from "@/lib/playback/source-url-ticket";
import {
  providerHealthRegistry,
  sourcesWithProviderHealth,
} from "@/lib/playback/health-registry";
import { tvQueryIndex } from "@/lib/playback/tv-index";
import { resolvePlaybackContentClass } from "@/lib/playback/content-class";
import { rememberPlaybackRoster } from "@/lib/playback/source-url-cache";
import { resolvePlayableTitle } from "@/lib/catalog/title-alias.server";
import { PlaybackTracker } from "@/lib/playback/playback-observability";

const FULL_RESOLVE_PER_TITLE_LIMIT = 12;
const FULL_RESOLVE_PER_USER_LIMIT = 90;
const FULL_RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const fullResolvePerTitleLimiter = new RateLimiter({
  limit: FULL_RESOLVE_PER_TITLE_LIMIT,
  windowMs: FULL_RESOLVE_WINDOW_MS,
});
const fullResolvePerUserLimiter = new RateLimiter({
  limit: FULL_RESOLVE_PER_USER_LIMIT,
  windowMs: FULL_RESOLVE_WINDOW_MS,
});

const NOCACHE_RESOLVE_LIMIT = 6;
const NOCACHE_RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const noCacheResolveLimiter = new RateLimiter({
  limit: NOCACHE_RESOLVE_LIMIT,
  windowMs: NOCACHE_RESOLVE_WINDOW_MS,
});

const RECOVERY_REFRESH_LIMIT = 3;
const RECOVERY_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const recoveryRefreshLimiter = new RateLimiter({
  limit: RECOVERY_REFRESH_LIMIT,
  windowMs: RECOVERY_REFRESH_WINDOW_MS,
});

function tooManyRequests(retryAfterMs: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    }
  );
}

/**
 * GET /api/playback/movie/550
 * GET /api/playback/tv/1399?season=1&episode=1
 *
 * Resolves playback for a title through the currently-configured PlaybackProvider
 * and returns a PlaybackResponse with structured PlaybackTracker observability.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> }
) {
  const url = new URL(req.url);
  const clientPlaybackId =
    req.headers.get("x-playback-id") ||
    url.searchParams.get("playbackId") ||
    undefined;

  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const { type, id } = await ctx.params;
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "Invalid media type" }, { status: 400 });
  }

  const requestedId = Number(id);
  if (!requestedId) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const playable = await resolvePlayableTitle(type, requestedId);
  const mediaType = playable.mediaType;
  const tmdbId = playable.tmdbId;

  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  let season = seasonParam != null && seasonParam !== "" ? Number(seasonParam) : undefined;
  let episode = episodeParam != null && episodeParam !== "" ? Number(episodeParam) : undefined;
  if (mediaType === "tv") {
    if (season == null && playable.season != null) season = playable.season;
    if (episode == null && playable.episode != null) episode = playable.episode;
    season = tvQueryIndex(Number.isFinite(season as number) ? season : undefined);
    episode = tvQueryIndex(Number.isFinite(episode as number) ? episode : undefined);
  }

  const tracker = new PlaybackTracker({
    playbackId: clientPlaybackId,
    mediaType,
    tmdbId,
    season,
    episode,
  });

  const wantFast =
    url.searchParams.get("fast") === "1" || url.searchParams.get("prefetch") === "1";
  const fastPathOk = await isPlaybackFastPathEnabled();
  const fast = wantFast && fastPathOk;
  const noCacheRequested = url.searchParams.get("nocache") === "1";
  const recoveryRefreshRequested = url.searchParams.get("refresh") === "1";
  const refreshMode = playbackRefreshMode({
    fast,
    adminNoCacheRequested: noCacheRequested,
    recoveryRefreshRequested,
    isAdmin: user.isAdmin,
  });
  const noCache = refreshMode !== "none";
  const refreshNonce = noCache ? Date.now() : undefined;

  if (!fast) {
    const titleResolveKey =
      `${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
    const resolveBudget = consumePlaybackResolveBudget({
      userLimiter: fullResolvePerUserLimiter,
      titleLimiter: fullResolvePerTitleLimiter,
      userKey: userId,
      titleKey: titleResolveKey,
      consumeTitle: consumesTitleResolveBudget(refreshMode),
    });
    if (!resolveBudget.allowed) {
      return tooManyRequests(
        resolveBudget.retryAfterMs,
        "Too many playback resolve requests. Please wait a moment and try again."
      );
    }
  }
  if (noCache) {
    const refreshKey =
      refreshMode === "recovery"
        ? `${userId}:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`
        : userId;
    const refreshCheck =
      refreshMode === "recovery"
        ? recoveryRefreshLimiter.consume(refreshKey)
        : noCacheResolveLimiter.consume(refreshKey);
    if (!refreshCheck.allowed) {
      return tooManyRequests(
        refreshCheck.retryAfterMs,
        "Too many forced refreshes. Please wait a few minutes and try again."
      );
    }
  }

  tracker.mark("auth_and_budget_verified", { fast, noCache });

  const [profilePreferences, contentClass, remuxAvailable] = await Promise.all([
    getUserPlaybackPreferences(userId),
    resolvePlaybackContentClass(mediaType, tmdbId),
    remuxHasCapacity(),
  ]);
  const qualityHint = profilePreferences.playbackQuality;
  const decideOptions = {
    preferredHeight: qualityHint,
    fourKStartup: profilePreferences.fourKStartup,
    remuxAvailable,
  } as const;
  const sourceCacheIdentity = {
    userId,
    mediaType,
    tmdbId,
    season,
    episode,
  };

  tracker.mark("preferences_loaded");

  const {
    getCachedPlayback,
    setCachedPlayback,
    playbackCacheKey,
    playbackResponseTtlMs,
  } = await import("@/lib/server-cache");

  const cacheKey = playbackCacheKey(
    mediaType,
    tmdbId,
    season,
    episode,
    fast,
    userId,
    qualityHint,
    contentClass
  );

  if (!noCache) {
    const cached = getCachedPlayback<PlaybackResponse>(cacheKey);
    if (cached) {
      const healthAware = withRuntimeProviderHealth(
        cached,
        userId,
        mediaType,
        decideOptions
      );
      rememberPlaybackRoster(sourceCacheIdentity, healthAware.sources);
      tracker.mark("cache_hit");
      tracker.setSelectedSource({
        id: healthAware.streamUrl || "cached",
        quality: healthAware.sources?.[0]?.quality || "auto",
        provider: "cache",
      });
      tracker.logSummary("info");

      return NextResponse.json({
        ...healthAware,
        preferences: profilePreferences,
        remuxAvailable,
      }, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Playback-Cache": "HIT",
          "X-Playback-Id": tracker.playbackId,
          "X-Playback-Timing": tracker.getTimingHeaderValue(),
        },
      });
    }
  }

  tracker.mark("cache_miss_dispatched");
  const provider = await getProvider();

  const debridPromise = fast
    ? resolveFastDebridSourcesSafely({
        tmdbId,
        mediaType,
        season,
        episode,
      })
    : resolveDebridSourcesSafely({
        tmdbId,
        mediaType,
        season,
        episode,
        forceRefresh: noCache,
      });

  const providerPromise = provider.resolve({
    tmdbId,
    mediaType,
    season,
    episode,
    userId,
    fast,
    noCache,
    qualityHint,
    contentClass,
  });

  let result: PlaybackResponse;
  if (fast) {
    const debridSources = await debridPromise;
    const debridOnly = buildFastDebridResponse(
      debridSources,
      qualityHint ?? "auto",
      decideOptions
    );
    if (debridOnly) {
      result = debridOnly;
      tracker.mark("fast_debrid_hit", { count: debridSources.length });
      void providerPromise.catch(() => undefined);
      console.info(
        JSON.stringify({
          event: "playback_fast_debrid_hit",
          mediaType,
          tmdbId,
          sourceCount: debridSources.length,
        })
      );
    } else {
      result = await providerPromise;
      tracker.mark("provider_resolved", { count: result.sources?.length ?? 0 });
      mergeDebridSources(result, debridSources, decideOptions);
    }
  } else {
    const [providerResult, resolvedDebridSources] = await Promise.all([
      providerPromise,
      debridPromise,
    ]);
    tracker.mark("full_resolvers_settled", {
      providerCount: providerResult.sources?.length ?? 0,
      debridCount: resolvedDebridSources.length,
    });
    const debridSources =
      refreshMode === "recovery" && refreshNonce != null
        ? proxyRecoveryDebridSources(
            userId,
            resolvedDebridSources,
            refreshNonce
          )
        : resolvedDebridSources;
    result = providerResult;
    mergeDebridSources(result, debridSources, decideOptions);
  }

  if (result && result.status !== "error") {
    setCachedPlayback(cacheKey, result, playbackResponseTtlMs(result));
  }

  const healthAwareResult = withRuntimeProviderHealth(
    result,
    userId,
    mediaType,
    decideOptions
  );
  rememberPlaybackRoster(sourceCacheIdentity, healthAwareResult.sources);

  tracker.setSelectedSource({
    id: healthAwareResult.streamUrl || "none",
    quality: healthAwareResult.sources?.[0]?.quality || "auto",
    provider: healthAwareResult.providerId || "scraped",
  });
  tracker.logSummary("info");

  return NextResponse.json({
    ...healthAwareResult,
    preferences: profilePreferences,
    remuxAvailable,
    ...(refreshNonce != null ? { refreshNonce } : {}),
  }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Playback-Cache": "MISS",
      "X-Playback-Id": tracker.playbackId,
      "X-Playback-Timing": tracker.getTimingHeaderValue(),
    },
  });
}

function withRuntimeProviderHealth(
  result: PlaybackResponse,
  viewerId: string,
  contentClass: MediaType,
  decideOptions: DecidePlaybackOptions
): PlaybackResponse {
  if (!result.sources?.length) return result;
  const sources = sourcesWithProviderHealth(
    result.sources,
    providerHealthRegistry,
    { contentClass, viewerId }
  );
  const best = decideImmediateSource(sources, decideOptions);
  const ticketed = stampSourceUrlTickets(sources, viewerId);
  return {
    ...result,
    sources: ticketed,
    streamUrl: best?.url ?? result.streamUrl,
  };
}

async function resolveDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  forceRefresh?: boolean;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveDebridSources } = await import("@/lib/playback/debrid");
    return await resolveDebridSources(req);
  } catch {
    return [];
  }
}

async function resolveFastDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveFastDebridSources } = await import("@/lib/playback/debrid");
    return await resolveFastDebridSources(req);
  } catch {
    return [];
  }
}

function mergeDebridSources(
  result: PlaybackResponse,
  debridSources: PlaybackSource[],
  decideOptions: DecidePlaybackOptions
): void {
  if (!debridSources.length) return;
  const merged = [...(result.sources ?? []), ...debridSources];
  result.sources = merged;
  const best =
    decideImmediateSource(merged, decideOptions) ??
    merged[0];
  if (!best) return;
  result.streamUrl = best.url;
  if (result.status === "error" || result.status === "not_configured") {
    result.status = "available";
    result.message = undefined;
    result.action = undefined;
  }
}
