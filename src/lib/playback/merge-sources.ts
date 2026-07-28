import type { PlaybackSource } from "./types";

/**
 * Progressive responses normally keep the first URL so an active proxy
 * session is not torn down by metadata enrichment. A deliberate recovery is
 * the exception: the full response's URL is the point of the refresh.
 */
export function mergeProgressivePlaybackSources(
  fastSources: PlaybackSource[] = [],
  fullSources: PlaybackSource[] = [],
  preferFreshFullUrls = false
): PlaybackSource[] {
  const byId = new Map<string, PlaybackSource>();
  for (const source of fastSources) byId.set(source.id, source);
  for (const source of fullSources) {
    const existing = byId.get(source.id);
    if (!existing || preferFreshFullUrls) {
      byId.set(source.id, source);
      continue;
    }
    const patch: Partial<PlaybackSource> = {};
    if (source.probe != null) patch.probe = source.probe;
    if (source.maxHeight != null) patch.maxHeight = source.maxHeight;
    if (source.ladder != null && source.ladder.length) patch.ladder = source.ladder;
    if (source.type) patch.type = source.type;
    if (source.qualitySource) patch.qualitySource = source.qualitySource;
    if (source.verified !== undefined) patch.verified = source.verified;
    if (Object.keys(patch).length) {
      byId.set(source.id, { ...existing, ...patch });
    }
  }
  return Array.from(byId.values());
}
