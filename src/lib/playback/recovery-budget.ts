/**
 * A resolver recovery must stop before the player releases ownership of the
 * failed HLS generation. Keep the transport wall comfortably inside the
 * player deadline so a late retry can never interrupt a healthy failover.
 */
export const PLAYBACK_RECOVERY_WALL_MS = 40_000;
export const HLS_SESSION_REFRESH_TIMEOUT_MS = 45_000;
