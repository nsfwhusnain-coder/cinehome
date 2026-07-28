import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getProvider } from "@/lib/playback";
import type { MediaType, PlaybackResponse, PlaybackSource } from "@/lib/playback";
import { isPlaybackFastPathEnabled } from "@/lib/feature-flags";
import { pickDefaultSource } from "@/lib/playback/source-quality";
import { buildFastDebridResponse } from "@/lib/playback/fast-debrid";
import { RateLimiter } from "@/lib/rate-limit";
import { getUserPlaybackPreferences } from "@/lib/profile-preferences.server";
import { playbackRefreshMode } from "@/lib/playback/refresh-mode";
import { proxyRecoveryDebridSources } from "@/lib/playback/recovery-proxy";

/**
 * Rate limiting (KD-sec fix #4). Two separate limiters so normal browsing
 * (hover-prefetch, the fast cache-only check that fires on every card/detail
 * view) never gets throttled while the genuinely expensive paths do:
 *
 * - Full resolves have a per-title budget for broken client loops and a
 *   wider per-user budget for rapid catalogue abuse. A thin roster normally
 *   uses one initial resolve plus five progressive polls and one recovery.
 *   Keeping those keys separate prevents one slow title from starving every
 *   other title the same user opens during the five-minute window.
 * - `noCacheResolveLimiter` bounds `nocache=1` requests specifically (admin
 *   -only — see below), which skip even the raw-scrape cache and force a
 *   brand new scrape + debrid resolve every single call.
 * - `recoveryRefreshLimiter` gives an authenticated user at most three
 *   cache-bypassing recovery attempts per title in ten minutes after the
 *   player exhausts a roster. The global full-resolve limiter still applies.
 */
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

  if (!fast) {
    const titleResolveKey =
      `${userId}:${type}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
    const userCheck = fullResolvePerUserLimiter.consume(userId);
    const titleCheck = fullResolvePerTitleLimiter.consume(titleResolveKey);
    if (!userCheck.allowed || !titleCheck.allowed) {
      const retryAfterMs = Math.max(
        userCheck.allowed ? 0 : userCheck.retryAfterMs,
        titleCheck.allowed ? 0 : titleCheck.retryAfterMs
      );
      return tooManyRequests(
        retryAfterMs,
        "Too many playback resolve requests. Please wait a moment and try again."
      );
    }
  }
  if (noCache) {
    const refreshKey =
      refreshMode === "recovery"
        ? `${userId}:${type}:${tmdbId}:${season ?? 0}:${episode ?? 0}`
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
      return NextResponse.json({ ...cached, preferences: profilePreferences }, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Playback-Cache": "HIT",
        },
      });
    }
  }

  const provider = await getProvider();

  // PREMIUM debrid tier (owner's Real-Debrid + Torrentio, primary/fast/
  // high-volume source) — kicked off in PARALLEL with the base embed resolve
  // on both paths:
  //   - fast/prefetch: `resolveFastDebridSourcesSafely` is CACHE-ONLY — it
  //     checks the single best browser-safe (native H.264/MP4) cached source
  //     with a bounded DB read and NEVER performs a live Torrentio/RD network
  //     resolve on this path (that would spend seconds on every cold-cache
  //     request for ~no benefit, since the client already fires a parallel
  //     `full` request that resolves the entire roster live). A cache hit
  //     returns near-instantly; a cache miss returns [] immediately and the
  //     embed sources serve alone — RD can never delay this response. The
  //     full live roster resolve (Safari-4K, additional native 1080p
  //     releases, and the cold-cache pick itself if there was one) always
  //     still happens, entirely in the background, so a follow-up full
  //     resolve or the next repeat view finds a warm, richer cache.
  //   - full: `resolveDebridSourcesSafely` resolves (or reads from cache)
  //     the entire RD roster + the TorBox sibling tier, live if needed.
  // No-ops to [] when neither REAL_DEBRID_API_TOKEN nor TORBOX_API_KEY is
  // set, or anything in the tier fails.
  const debridPromise = fast
    ? resolveFastDebridSourcesSafely({
        tmdbId,
        mediaType: type as MediaType,
        season,
        episode,
      })
    : resolveDebridSourcesSafely({
        tmdbId,
        mediaType: type as MediaType,
        season,
        episode,
        forceRefresh: noCache,
      });

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

  let result: PlaybackResponse;
  if (fast) {
    const debridSources = await debridPromise;
    const debridOnly = buildFastDebridResponse(
      debridSources,
      qualityHint ?? "auto"
    );
    if (debridOnly) {
      result = debridOnly;
      // Provider discovery was already started in parallel. Let it populate
      // its own scraper cache for the full request without gating first frame.
      void providerPromise.catch(() => undefined);
      console.info(
        JSON.stringify({
          event: "playback_fast_debrid_hit",
          mediaType: type,
          tmdbId,
          sourceCount: debridSources.length,
        })
      );
    } else {
      result = await providerPromise;
      mergeDebridSources(result, debridSources, qualityHint);
    }
  } else {
    const [providerResult, resolvedDebridSources] = await Promise.all([
      providerPromise,
      debridPromise,
    ]);
    const debridSources =
      refreshMode === "recovery" && refreshNonce != null
        ? proxyRecoveryDebridSources(
            userId,
            resolvedDebridSources,
            refreshNonce
          )
        : resolvedDebridSources;
    result = providerResult;
    mergeDebridSources(result, debridSources, qualityHint);
  }

  // Cache available resolves for warm Play. Partial → short TTL so poll advances.
  if (result && result.status !== "error") {
    const ttl = result.partial ? PLAYBACK_PARTIAL_TTL_MS : PLAYBACK_TTL_MS;
    setCachedPlayback(cacheKey, result, ttl);
  }

  return NextResponse.json({
    ...result,
    preferences: profilePreferences,
    ...(refreshNonce != null ? { refreshNonce } : {}),
  }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Playback-Cache": "MISS",
    },
  });
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
