import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getProvider } from "@/lib/playback";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback";
import { isPlaybackFastPathEnabled } from "@/lib/feature-flags";
import { pickDefaultSource } from "@/lib/playback/source-quality";
import { buildFastDebridResponse } from "@/lib/playback/fast-debrid";
import { RateLimiter } from "@/lib/rate-limit";
import { getUserPlaybackPreferences } from "@/lib/profile-preferences.server";
import {
  consumesTitleResolveBudget,
  playbackRefreshMode,
} from "@/lib/playback/refresh-mode";
import { prepareDebridSourcesForBrowser } from "@/lib/playback/recovery-proxy";
import { consumePlaybackResolveBudget } from "@/lib/playback/resolve-budget";
import { shouldConsumePlaybackResolveBudget } from "@/lib/playback/resolve-budget-policy";

/**
 * Rate limiting (KD-sec fix #4). Two separate limiters so normal browsing
 * (hover-prefetch, the fast cache-only check that fires on every card/detail
 * view) never gets throttled while the genuinely expensive paths do:
 *
 * - Full resolves have a per-title budget for broken client loops and a
 *   wider per-user budget for rapid catalogue abuse. A thin roster normally
 *   uses one initial resolve plus five progressive polls and one recovery.
 *   Keeping those keys separate prevents one slow title from starving every
 *   other title the same user opens during the five-minute window. Recovery
 *   bypasses this normal title bucket because its own stricter limiter below
 *   reserves the emergency path after progressive polling is exhausted.
 * - `noCacheResolveLimiter` bounds `nocache=1` requests specifically (admin
 *   -only — see below), which skip even the raw-scrape cache and force a
 *   brand new scrape + debrid resolve every single call.
 * - `recoveryRefreshLimiter` gives an authenticated user at most three
 *   cache-bypassing recovery attempts per title in ten minutes after the
 *   player exhausts a roster. The global full-resolve limiter still applies.
 */
// One watch page can make one initial full request plus five bounded
// progressive polls. Allow several legitimate reloads/devices in the same
// five-minute window; the separate per-user ceiling still bounds catalogue
// abuse across titles.
const FULL_RESOLVE_PER_TITLE_LIMIT = 30;
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

function tooManyRequests(
  retryAfterMs: number,
  message: string,
  requestId: string
): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        "X-Playback-Request-Id": requestId,
      },
    }
  );
}

interface PlaybackOutcomeLog {
  requestId: string;
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
  fast: boolean;
  refreshMode: "none" | "admin" | "recovery";
  cache: "HIT" | "MISS" | "BYPASS";
  outcome: string;
  status: number;
  startedAt: number;
  sourceCount?: number;
  partial?: boolean;
  deniedScope?: "title" | "user" | "refresh";
}

/**
 * One sanitized completion record per playback API request. Never include
 * upstream URLs, provider tokens, cookies, user ids, or error messages: the
 * opaque request id is sufficient to join this route with browser telemetry.
 */
function logPlaybackOutcome(input: PlaybackOutcomeLog): void {
  console.info(
    JSON.stringify({
      event: "playback_resolve_outcome",
      requestId: input.requestId,
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
      season: input.season ?? 0,
      episode: input.episode ?? 0,
      fast: input.fast,
      refreshMode: input.refreshMode,
      cache: input.cache,
      outcome: input.outcome,
      status: input.status,
      elapsedMs: Date.now() - input.startedAt,
      ...(input.sourceCount != null ? { sourceCount: input.sourceCount } : {}),
      ...(input.partial != null ? { partial: input.partial } : {}),
      ...(input.deniedScope ? { deniedScope: input.deniedScope } : {}),
    })
  );
}

/**
 * GET /api/playback/movie/550
 * GET /api/playback/tv/1399?season=1&episode=1
 *
 * Resolves playback for a title through the currently-configured PlaybackProvider
 * (see src/lib/playback/index.ts) and returns a PlaybackResponse.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> }
) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const { type, id } = await ctx.params;
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "Invalid media type" }, { status: 400 });
  }

  const tmdbId = Number(id);
  if (!tmdbId) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  // TV requires S/E for scrapers. Default S1E1 when omitted (card Play, deep links).
  let season = seasonParam ? Number(seasonParam) : undefined;
  let episode = episodeParam ? Number(episodeParam) : undefined;
  if (type === "tv") {
    if (!Number.isFinite(season) || (season as number) < 1) season = 1;
    if (!Number.isFinite(episode) || (episode as number) < 1) episode = 1;
  }
  const wantFast =
    url.searchParams.get("fast") === "1" || url.searchParams.get("prefetch") === "1";
  // Admin flag can disable Luna fast-path; full resolve only.
  const fastPathOk = await isPlaybackFastPathEnabled();
  const fast = wantFast && fastPathOk;
  // nocache=1 remains the admin diagnostic control. refresh=1 is the bounded
  // authenticated recovery path used after a real player roster is exhausted.
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
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const titleResolveKey =
    `${userId}:${type}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;

  const consumeFullResolveBudget = () =>
    consumePlaybackResolveBudget({
      userLimiter: fullResolvePerUserLimiter,
      titleLimiter: fullResolvePerTitleLimiter,
      userKey: userId,
      titleKey: titleResolveKey,
      consumeTitle: consumesTitleResolveBudget(refreshMode),
    });

  // A forced refresh deliberately bypasses cache, so it remains budgeted
  // before any cache/profile work. Ordinary full requests are budgeted only
  // after a cache miss below: replaying a warm result is not a live resolve.
  if (
    shouldConsumePlaybackResolveBudget({
      fast,
      refreshMode,
      cache: "BYPASS",
    })
  ) {
    const resolveBudget = consumeFullResolveBudget();
    if (!resolveBudget.allowed) {
      logPlaybackOutcome({
        requestId,
        mediaType: type,
        tmdbId,
        season,
        episode,
        fast,
        refreshMode,
        cache: "BYPASS",
        outcome: "rate_limited",
        status: 429,
        startedAt,
        deniedScope: resolveBudget.deniedScope ?? undefined,
      });
      return tooManyRequests(
        resolveBudget.retryAfterMs,
        "Too many playback resolve requests. Please wait a moment and try again.",
        requestId
      );
    }
  }
  if (noCache) {
    const refreshKey =
      refreshMode === "recovery"
        ? titleResolveKey
        : userId;
    const refreshCheck =
      refreshMode === "recovery"
        ? recoveryRefreshLimiter.consume(refreshKey)
        : noCacheResolveLimiter.consume(refreshKey);
    if (!refreshCheck.allowed) {
      logPlaybackOutcome({
        requestId,
        mediaType: type,
        tmdbId,
        season,
        episode,
        fast,
        refreshMode,
        cache: "BYPASS",
        outcome: "rate_limited",
        status: 429,
        startedAt,
        deniedScope: "refresh",
      });
      return tooManyRequests(
        refreshCheck.retryAfterMs,
        "Too many forced refreshes. Please wait a few minutes and try again.",
        requestId
      );
    }
  }
  // The profile is authoritative on every device. Client hints are deliberately
  // ignored so a stale browser cache cannot override a newly selected default.
  const profilePreferences = await getUserPlaybackPreferences(userId);
  const qualityHint = profilePreferences.playbackQuality;

  const {
    getCachedPlayback,
    setCachedPlayback,
    playbackCacheKey,
    PLAYBACK_TTL_MS,
    PLAYBACK_PARTIAL_TTL_MS,
  } = await import("@/lib/server-cache");
  // Per-user key: proxy URLs embed HLS session ids. Cross-user warm is raw scrape.
  const cacheKey = playbackCacheKey(
    type,
    tmdbId,
    season,
    episode,
    fast,
    userId,
    qualityHint
  );

  if (!noCache) {
    const cached = getCachedPlayback<PlaybackResponse>(cacheKey);
    if (cached) {
      logPlaybackOutcome({
        requestId,
        mediaType: type,
        tmdbId,
        season,
        episode,
        fast,
        refreshMode,
        cache: "HIT",
        outcome: cached.status,
        status: 200,
        startedAt,
        sourceCount: cached.sources?.length ?? 0,
        partial: cached.partial,
      });
      return NextResponse.json({ ...cached, preferences: profilePreferences }, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Playback-Cache": "HIT",
          "X-Playback-Request-Id": requestId,
        },
      });
    }
  }

  if (
    shouldConsumePlaybackResolveBudget({
      fast,
      refreshMode,
      cache: "MISS",
    })
  ) {
    const resolveBudget = consumeFullResolveBudget();
    if (!resolveBudget.allowed) {
      logPlaybackOutcome({
        requestId,
        mediaType: type,
        tmdbId,
        season,
        episode,
        fast,
        refreshMode,
        cache: "MISS",
        outcome: "rate_limited",
        status: 429,
        startedAt,
        deniedScope: resolveBudget.deniedScope ?? undefined,
      });
      return tooManyRequests(
        resolveBudget.retryAfterMs,
        "Too many playback resolve requests. Please wait a moment and try again.",
        requestId
      );
    }
  }

  try {
    let result: PlaybackResponse | null = null;

    // A proven fast-cache hit is a complete first-frame answer. Check it
    // before constructing or starting any embed provider so the path is one
    // bounded SQLite read plus local ranking, with zero hidden background
    // discovery. The client already starts an independent full request.
    if (fast) {
      const fastDebridSources = prepareDebridSourcesForBrowser(
        userId,
        await resolveFastDebridSourcesSafely({
          tmdbId,
          mediaType: type as MediaType,
          season,
          episode,
        })
      );
      result = buildFastDebridResponse(
        fastDebridSources,
        qualityHint ?? "auto"
      );
      if (result) {
        console.info(
          JSON.stringify({
            event: "playback_fast_debrid_hit",
            requestId,
            mediaType: type,
            tmdbId,
            sourceCount: fastDebridSources.length,
            elapsedMs: Date.now() - startedAt,
          })
        );
      }
    }

    if (!result) {
      const provider = await getProvider();
      const providerPromise = provider.resolve({
        tmdbId,
        mediaType: type as MediaType,
        season,
        episode,
        userId,
        fast,
        noCache,
        qualityHint,
      });

      if (fast) {
        result = await providerPromise;
      } else {
        const debridPromise = resolveDebridSourcesSafely({
          tmdbId,
          mediaType: type as MediaType,
          season,
          episode,
          forceRefresh: noCache,
        });
        const [providerResult, resolvedDebridSources] = await Promise.all([
          providerPromise,
          debridPromise,
        ]);
        const debridSources = prepareDebridSourcesForBrowser(
          userId,
          resolvedDebridSources,
          refreshMode === "recovery" ? refreshNonce : undefined
        );
        result = providerResult;
        mergeDebridSources(result, debridSources, qualityHint);
      }
    }

    if (!result) {
      throw new Error("Playback resolver produced no response");
    }

  // Cache available resolves for warm Play. Partial → short TTL so poll advances.
  if (result && result.status !== "error") {
    const ttl = result.partial ? PLAYBACK_PARTIAL_TTL_MS : PLAYBACK_TTL_MS;
    setCachedPlayback(cacheKey, result, ttl);
  }

  logPlaybackOutcome({
    requestId,
    mediaType: type,
    tmdbId,
    season,
    episode,
    fast,
    refreshMode,
    cache: noCache ? "BYPASS" : "MISS",
    outcome: result.status,
    status: 200,
    startedAt,
    sourceCount: result.sources?.length ?? 0,
    partial: result.partial,
  });

  return NextResponse.json({
    ...result,
    preferences: profilePreferences,
    ...(refreshNonce != null ? { refreshNonce } : {}),
  }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Playback-Cache": noCache ? "BYPASS" : "MISS",
      "X-Playback-Request-Id": requestId,
    },
  });
  } catch (error) {
    // Keep failure telemetry useful but sanitized: exception messages can
    // contain provider URLs or signed query strings, so record only its class.
    console.error(
      JSON.stringify({
        event: "playback_resolve_error",
        requestId,
        mediaType: type,
        tmdbId,
        season: season ?? 0,
        episode: episode ?? 0,
        fast,
        refreshMode,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    );
    logPlaybackOutcome({
      requestId,
      mediaType: type,
      tmdbId,
      season,
      episode,
      fast,
      refreshMode,
      cache: noCache ? "BYPASS" : "MISS",
      outcome: "resolve_error",
      status: 500,
      startedAt,
    });
    return NextResponse.json(
      { error: "Playback resolution failed." },
      {
        status: 500,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Playback-Cache": noCache ? "BYPASS" : "MISS",
          "X-Playback-Request-Id": requestId,
        },
      }
    );
  }
}

/**
 * Dynamically imported so the Prisma-backed debrid module only loads on the
 * full resolve path. Wrapped in try/catch so an import or resolve failure
 * never breaks the base (embed) response.
 */
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

/**
 * Fast/prefetch-path counterpart — cache-only check for the single best
 * native RD source, hard-bounded to its own short defensive deadline
 * internally (see `resolveFastDebridSources` in
 * src/lib/playback/debrid/index.ts — it never performs a live network
 * resolve on this path). Wrapped in try/catch (mirroring
 * `resolveDebridSourcesSafely`) so an import or resolve failure never breaks
 * the base (embed) fast response.
 */
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

/**
 * Merge debrid sources into an already-resolved response — the existing
 * scoreSource/pickDefaultSource ranking (source-quality.ts) re-ranks the
 * combined roster and may promote a debrid source to default. If the base
 * roster came back empty (error/not_configured) but debrid found something,
 * promote the response to "available" so the premium tier can stand alone.
 */
function mergeDebridSources(
  result: PlaybackResponse,
  debridSources: PlaybackSource[],
  qualityHint?: "auto" | number
): void {
  if (!debridSources.length) return;
  const merged = [...(result.sources ?? []), ...debridSources];
  result.sources = merged;
  const best = pickDefaultSource(merged, null, qualityHint ?? "auto") ?? merged[0];
  if (!best) return;
  result.streamUrl = best.url;
  if (result.status === "error" || result.status === "not_configured") {
    result.status = "available";
    result.message = undefined;
    result.action = undefined;
  }
}
