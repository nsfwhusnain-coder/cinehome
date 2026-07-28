export type PlaybackRefreshMode = "none" | "admin" | "recovery";

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
