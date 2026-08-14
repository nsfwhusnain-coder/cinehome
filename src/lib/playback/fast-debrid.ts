import { decideImmediateSource } from "./decide-playback";
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
  const best = decideImmediateSource(sources, { preferredHeight: qualityHint });
  if (!best) return null;
  return {
    status: "available",
    streamUrl: best.url,
    sources,
    providerId: "debrid",
    partial: true,
  };
}
