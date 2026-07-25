import type { MediaType, PlaybackResponse } from "@/lib/playback";
import { getProvider } from "@/lib/playback";
import { mergeDebridSources, resolveDebridSourcesSafely } from "./merge-debrid";

/**
 * Resolve the FULL playback roster — base embed sources (provider.resolve) PLUS
 * the debrid tier (Real-Debrid + TorBox) merged in — identical to what
 * /api/playback returns on the full (non-fast) path.
 *
 * WHY THIS EXISTS: the debrid tier is NOT part of provider.resolve() — it's a
 * separate parallel call the playback route merges in (mergeDebridSources).
 * Routes that need to look up a specific source by id (e.g. /api/transcode,
 * which re-resolves to find the source the player picked) must reproduce that
 * SAME merge or debrid sources will be invisible to them (they'd 404 on every
 * debrid source id). This helper is the single shared way to do that.
 *
 * Never throws — debrid failures no-op to [] (see resolveDebridSourcesSafely).
 * qualityHint optional (mirrors the playback route).
 */
export async function resolveFullRoster(args: {
  userId: string;
  type: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
  qualityHint?: "auto" | number;
}): Promise<PlaybackResponse> {
  const { userId, type, tmdbId, season, episode, qualityHint } = args;

  const provider = await getProvider();

  const [result, debridSources] = await Promise.all([
    provider.resolve({
      tmdbId,
      mediaType: type,
      season,
      episode,
      userId,
      fast: false,
      qualityHint,
    }),
    resolveDebridSourcesSafely({ tmdbId, mediaType: type, season, episode }),
  ]);

  mergeDebridSources(result, debridSources, qualityHint);
  return result;
}

