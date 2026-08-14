/**
 * First-frame wall policy (R8).
 *
 * Caps how long the compact "loading" chip waits for a healthy first frame
 * before failing the active source. Cold multi-source starts fail over faster
 * than resume; mid-title resume and sole remaining sources keep the patient
 * window so slow-but-alive streams are not false-positive killed.
 *
 * Cold wall raised to ~20s (R10): Vixsrc multi-variant **media** playlists are
 * large (~0.5MB rewritten) and often need 10–20s on the first CDN hop. An 11s
 * wall killed healthy sources mid level-load after the synthetic-wrap loop was
 * fixed (segments never got a chance to decode).
 */

/** Cold start wall when at least one alternate source remains. */
export const FIRST_FRAME_WALL_COLD_MS = 20_000;
/** Mid-title resume / sole-source patient wall. */
export const FIRST_FRAME_WALL_RESUME_MS = 28_000;
/**
 * Remux/transcode packer wall. Matches `TRANSCODE_ZERO_PROGRESS_FAIL_MS`
 * (52s) so the first-frame timer cannot kill a healthy remux before the
 * packer is allowed to produce the first fragment.
 */
export const FIRST_FRAME_WALL_REMUX_MS = 52_000;
/** Resume position (s) above this uses the patient wall. */
export const FIRST_FRAME_WALL_RESUME_THRESHOLD_S = 5;

export type FirstFrameWallOpts = {
  /** Continue-watching / mid-switch resume position in seconds. */
  resumeAt?: number | null;
  /**
   * Count of other playable sources that would remain if the active source
   * failed (excludes the current active source). 0 = sole remaining source.
   */
  remainingSources: number;
  /** Active source is remux or `/api/transcode` — packer needs the long wall. */
  remuxOrTranscode?: boolean;
};

/**
 * Duration of the first-frame wall timer in ms.
 *
 * | Scenario                         | Wall        |
 * |----------------------------------|-------------|
 * | Cold, multi-source (remaining≥1) | 20_000      |
 * | Resume mid-title (remaining≥1)   | 28_000      |
 * | Sole remaining source            | 28_000      |
 * | Remux / transcode (any of above) | ≥ 52_000    |
 */
export function firstFrameWallMs(opts: FirstFrameWallOpts): number {
  const remaining = Math.max(0, opts.remainingSources | 0);
  // Nowhere to fail over — give the only source the full patient window.
  let wall = FIRST_FRAME_WALL_COLD_MS;
  if (remaining === 0) {
    wall = FIRST_FRAME_WALL_RESUME_MS;
  } else {
    const resumeAt = opts.resumeAt ?? 0;
    if (resumeAt > FIRST_FRAME_WALL_RESUME_THRESHOLD_S) {
      wall = FIRST_FRAME_WALL_RESUME_MS;
    }
  }
  if (opts.remuxOrTranscode) {
    return Math.max(wall, FIRST_FRAME_WALL_REMUX_MS);
  }
  return wall;
}
