/**
 * When the end-of-episode card is allowed to appear.
 *
 * Pure so it can be tested without a DOM, a store or a running stream — the
 * card itself (`NextEpisodeCountdown` in views/watch.tsx) is markup plus a
 * timer around this.
 */

/**
 * How far before the end the card may appear.
 *
 * The card used to wait for `ended`, which means it arrived only once the
 * credits had finished rolling — too late to be the "skip the credits, start
 * the next one" affordance it looks like. There is no credits-marker data
 * upstream (nothing in the roster or in TMDB says where an episode's credits
 * begin), so this is a fixed tail rather than a detected boundary, and the
 * copy stays "Next episode" rather than claiming otherwise.
 */
export const UP_NEXT_TAIL_S = 75;
/** Below this, a 75s tail would be a large fraction of the whole runtime. */
export const UP_NEXT_MIN_DURATION_S = 420;

export function shouldShowUpNext(
  currentTime: number,
  duration: number,
  /**
   * True while `duration` is still growing — a remux is produced live, so
   * until its playlist closes, `duration` is how much has been remuxed rather
   * than how long the episode is, and the tail would land nowhere near the
   * end. See `durationProvisional` in video-player.tsx.
   */
  durationProvisional = false,
  /** TMDB runtime in seconds, used in place of a provisional duration. */
  fallbackDurationS = 0
): boolean {
  // A provisional duration is unusable, but TMDB's runtime is not — prefer it
  // rather than hiding the card for the whole of a remuxed episode.
  const effective = durationProvisional ? fallbackDurationS : duration;
  // `duration` is 0 until metadata loads. Without this guard the tail test is
  // trivially true at t=0 and the card appears before playback starts.
  if (!Number.isFinite(effective) || effective < UP_NEXT_MIN_DURATION_S) return false;
  return currentTime >= effective - UP_NEXT_TAIL_S;
}
