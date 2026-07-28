export type PlaybackRefreshMode = "none" | "admin" | "recovery";

/**
 * Recovery has its own strict per-title limiter. It must not also consume the
 * normal progressive-resolve bucket: a thin roster can legitimately exhaust
 * that bucket before its last source dies, which would otherwise deny the
 * emergency refresh precisely when it is needed.
 */
export function consumesTitleResolveBudget(
  refreshMode: PlaybackRefreshMode
): boolean {
  return refreshMode !== "recovery";
}

export function playbackRefreshMode(args: {
  fast: boolean;
  adminNoCacheRequested: boolean;
  recoveryRefreshRequested: boolean;
  isAdmin: boolean;
}): PlaybackRefreshMode {
  if (args.fast) return "none";
  if (args.adminNoCacheRequested && args.isAdmin) return "admin";
  if (args.recoveryRefreshRequested) return "recovery";
  return "none";
}
