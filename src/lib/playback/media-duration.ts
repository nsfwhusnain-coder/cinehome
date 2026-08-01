import type { MediaType } from "./types";

/**
 * Runtime comparisons are deliberately conservative. TMDB runtimes can vary
 * by cut and TV episodes can be much shorter than a series average, so this
 * rejects only gross mismatches such as a trailer/sample being returned for a
 * feature or normal episode.
 */
const MIN_EXPECTED_DURATION_S = 10 * 60;
const MOVIE_MIN_RUNTIME_RATIO = 0.4;
const EPISODE_MIN_RUNTIME_RATIO = 0.2;
const MOVIE_MIN_SHORTFALL_S = 15 * 60;
const EPISODE_MIN_SHORTFALL_S = 5 * 60;

export interface MediaDurationAssessment {
  plausible: boolean;
  observedDurationS: number;
  expectedDurationS: number;
  minimumPlausibleDurationS: number;
}

/**
 * Decide whether a measured stream can plausibly be the requested title.
 * Unknown/non-finite durations remain available; only conclusive mismatches
 * fail closed.
 */
export function assessMediaDuration(
  observedDurationS: number,
  expectedDurationS: number,
  mediaType: MediaType
): MediaDurationAssessment {
  const observed = Number.isFinite(observedDurationS)
    ? Math.max(0, observedDurationS)
    : 0;
  const expected = Number.isFinite(expectedDurationS)
    ? Math.max(0, expectedDurationS)
    : 0;
  const ratio = mediaType === "movie"
    ? MOVIE_MIN_RUNTIME_RATIO
    : EPISODE_MIN_RUNTIME_RATIO;
  const minimumShortfall = mediaType === "movie"
    ? MOVIE_MIN_SHORTFALL_S
    : EPISODE_MIN_SHORTFALL_S;
  const minimumPlausibleDurationS = expected * ratio;

  if (
    observed <= 0 ||
    expected < MIN_EXPECTED_DURATION_S ||
    expected - observed < minimumShortfall
  ) {
    return {
      plausible: true,
      observedDurationS: observed,
      expectedDurationS: expected,
      minimumPlausibleDurationS,
    };
  }

  return {
    plausible: observed >= minimumPlausibleDurationS,
    observedDurationS: observed,
    expectedDurationS: expected,
    minimumPlausibleDurationS,
  };
}

/** Sum the advertised duration of an HLS media playlist. */
export function hlsMediaDurationSeconds(manifestText: string): number {
  let total = 0;
  let segments = 0;
  for (const rawLine of manifestText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("#EXTINF:")) continue;
    const rawDuration = line.slice("#EXTINF:".length).split(",", 1)[0];
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    total += duration;
    segments += 1;
  }
  return segments > 0 ? total : 0;
}
