import type { MediaType, PlaybackSource } from "./types";

/** Long enough to cover remux first-playlist + mid-title seeks without a re-scrape. */
export const SOURCE_URL_CACHE_TTL_MS = 10 * 60 * 1000;

export interface PlaybackSourceCacheIdentity {
  userId: string;
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
}

export interface CachedPlaybackSourceUrl {
  url: string;
  container?: PlaybackSource["container"];
  codec?: PlaybackSource["codec"];
}

interface SourceUrlCacheEntry {
  value: CachedPlaybackSourceUrl;
  expiresAt: number;
}

const sourceUrlCache = new Map<string, SourceUrlCacheEntry>();

function optionalIndex(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function playbackSourceCacheKey(
  args: PlaybackSourceCacheIdentity & { sourceId: string }
): string {
  return [
    args.userId,
    args.mediaType,
    args.tmdbId,
    optionalIndex(args.season),
    optionalIndex(args.episode),
    args.sourceId,
  ].join(":");
}

export function rememberPlaybackSource(
  args: PlaybackSourceCacheIdentity & {
    source: Pick<PlaybackSource, "id" | "url" | "container" | "codec">;
  }
): void {
  if (!args.source.id || !args.source.url) return;
  sourceUrlCache.set(
    playbackSourceCacheKey({ ...args, sourceId: args.source.id }),
    {
      value: {
        url: args.source.url,
        ...(args.source.container ? { container: args.source.container } : {}),
        ...(args.source.codec ? { codec: args.source.codec } : {}),
      },
      expiresAt: Date.now() + SOURCE_URL_CACHE_TTL_MS,
    }
  );
}

export function rememberPlaybackRoster(
  identity: PlaybackSourceCacheIdentity,
  sources: readonly PlaybackSource[] | undefined
): void {
  if (!sources?.length) return;
  for (const source of sources) {
    rememberPlaybackSource({ ...identity, source });
    for (const rung of source.qualityRungs ?? []) {
      if (rung.height <= 0 || !rung.url) continue;
      rememberPlaybackSource({
        ...identity,
        source: {
          id: `${source.id}::${rung.height}`,
          url: rung.url,
          container: source.container,
          codec: source.codec,
        },
      });
    }
  }
}

export function lookupPlaybackSourceUrl(
  args: PlaybackSourceCacheIdentity & { sourceId: string },
  now = Date.now()
): CachedPlaybackSourceUrl | null {
  const key = playbackSourceCacheKey(args);
  const entry = sourceUrlCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    sourceUrlCache.delete(key);
    return null;
  }
  return entry.value;
}

export function clearPlaybackSourceUrlCache(): void {
  sourceUrlCache.clear();
}
