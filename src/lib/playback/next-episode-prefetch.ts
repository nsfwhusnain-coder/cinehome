/** Warm next-episode sources once the current title is this far through. */
export const NEXT_EP_PRELOAD_RATIO = 0.45;

export function shouldPrefetchNextEpisode(args: {
  alreadyPreloaded: boolean;
  mediaType: string;
  tvId?: number | null;
  hasNextTarget: boolean;
  progressDuration: number;
  currentTime: number;
  ratio?: number;
}): boolean {
  if (args.alreadyPreloaded) return false;
  if (args.mediaType !== "tv") return false;
  if (args.tvId == null) return false;
  if (!args.hasNextTarget) return false;
  if (!(args.progressDuration > 0)) return false;
  const ratio = args.ratio ?? NEXT_EP_PRELOAD_RATIO;
  return args.currentTime / args.progressDuration >= ratio;
}
