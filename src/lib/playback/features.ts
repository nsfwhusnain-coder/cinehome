/** Kill switches: set any value to "0" and rebuild to restore legacy behavior. */
export const PLAYBACK_TRACK_POLICY_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_TRACK_POLICY !== "0";
export const PLAYBACK_FAST_4K_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_FAST_4K !== "0";
export const PLAYBACK_4K_PREWARM_ENABLED =
  process.env.NEXT_PUBLIC_PLAYBACK_4K_PREWARM !== "0";

export const PLAYBACK_COORDINATOR_SHADOW_ENABLED =
  process.env.PLAYBACK_COORDINATOR_SHADOW === "1";
