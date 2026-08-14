/** Kill switches: set any value to "0" and rebuild to restore legacy behavior. */
export const PLAYBACK_TRACK_POLICY_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_TRACK_POLICY !== "0";
export const PLAYBACK_FAST_4K_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_FAST_4K !== "0";
export const PLAYBACK_4K_PREWARM_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_4K_PREWARM !== "0";
/**
 * Offset-aware remuxing makes a live-generated fMP4 playlist seekable on the
 * title's logical timeline. Set to "0" and rebuild for an immediate rollback
 * to the legacy grow-from-zero behavior.
 */
export const PLAYBACK_RANDOM_ACCESS_REMUX_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_RANDOM_ACCESS_REMUX !== "0";
