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
  const eligible =
    typeof qualityHint === "number"
      ? sources.filter((source) => {
          const advertised = source.ladder?.length
            ? source.ladder
            : [sourceMaxHeight(source)];
          return advertised.includes(qualityHint);
        })
      : sources;
  // A fixed profile is a delivery constraint, not a scoring suggestion. If
  // the fast single-file roster lacks that exact rung, fall through to the
  // adaptive provider path rather than silently starting a larger file.
  const best = pickDefaultSource(eligible, null, qualityHint);
  if (!best) return null;
  return {
    status: "available",
    streamUrl: best.url,
    sources: eligible,
    providerId: "debrid",
    partial: true,
  };
}
