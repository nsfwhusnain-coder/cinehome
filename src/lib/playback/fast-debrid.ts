import { pickDefaultSource, sourceMaxHeight } from "./source-quality";
import type { PlaybackResponse, PlaybackSource } from "./types";

/**
 * A cache-only debrid hit is already a complete first-frame answer. The fast
 * API must not hold it behind free-provider discovery; the parallel full
 * request will enrich the roster moments later.
 */
export function buildFastDebridResponse(
  sources: PlaybackSource[],
  qualityHint: "auto" | number = "auto"
): PlaybackResponse | null {
  const exactMatches =
    typeof qualityHint === "number"
      ? sources.filter((source) => {
          const advertised = source.ladder?.length
            ? source.ladder
            : [sourceMaxHeight(source)];
          return advertised.includes(qualityHint);
        })
      : sources;
  // Prefer the exact saved rung, but never turn a verified cache hit into a
  // blank player merely because that title does not carry the requested
  // resolution. The stable quality rail marks the missing rung unavailable;
  // playback starts on the closest ranked source while the parallel full
  // resolver continues looking for an exact adaptive match.
  const best = pickDefaultSource(
    exactMatches.length ? exactMatches : sources,
    null,
    qualityHint
  );
  if (!best) return null;
  return {
    status: "available",
    streamUrl: best.url,
    // Keep every independently-proven backup visible. Filtering this list to
    // the selected quality made server options disappear between profile
    // choices and removed same-quality failover candidates.
    sources,
    providerId: "debrid",
    partial: true,
  };
}
