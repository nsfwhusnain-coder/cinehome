/**
 * Embed duration identity — reject trailer/sample HLS for feature films.
 * TV specials and ~20 min episodes stay on the shared conservative helper.
 */

import { assessMediaDuration } from "../../src/lib/playback/media-duration";
import type { MediaType } from "../../src/lib/playback/types";

/** TMDB feature-length floor. Short films stay ungated by the clip cap. */
export const FEATURE_MOVIE_MIN_EXPECTED_S = 80 * 60;
/** Official trailers, teasers, and scene samples. Alternate cuts are much longer. */
export const MOVIE_CLIP_MAX_S = 15 * 60;

/**
 * True when a measured playlist cannot be the requested title.
 * Unknown/non-finite durations stay available (fail open).
 *
 * Movies expected ≥80 min cannot be a 3–15 min clip even if the shared
 * helper is later loosened. TV uses assessMediaDuration only so specials
 * and ~20 min episodes are not rejected.
 */
export function isImplausibleEmbedDuration(
  observedS: number,
  expectedS: number,
  mediaType: MediaType
): boolean {
  if (!Number.isFinite(observedS) || observedS <= 0) return false;
  if (!Number.isFinite(expectedS) || expectedS <= 0) return false;

  if (
    mediaType === "movie" &&
    expectedS >= FEATURE_MOVIE_MIN_EXPECTED_S &&
    observedS <= MOVIE_CLIP_MAX_S
  ) {
    return true;
  }

  return !assessMediaDuration(observedS, expectedS, mediaType).plausible;
}
