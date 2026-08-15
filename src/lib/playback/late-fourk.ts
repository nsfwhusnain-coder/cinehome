import type { PlaybackSource } from "./types";
import {
  isSourcePlayableHere,
  pickDefaultSource,
  resolvePreferredHeightTarget,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";

export const UHD_HEIGHT = 2160;

/** Auto and unset hunt 4K. An explicit 1080/720 profile stays at that cap. */
export function wantsFourKDiscovery(
  preferred: "auto" | number | null | undefined
): boolean {
  return resolvePreferredHeightTarget(preferred) >= UHD_HEIGHT;
}

/**
 * After first frame, adopt a newly arrived playable 4K once.
 * Remux 4K stays picker-only so small seeks do not wait on ffmpeg prepare.
 */
export function findLateFourKSource(
  current: PlaybackSource,
  sources: readonly PlaybackSource[],
  options: {
    preferredProvider?: string | null;
    preferredHeight?: "auto" | number | null;
    failedIds?: ReadonlySet<string> | readonly string[];
  } = {}
): PlaybackSource | null {
  if (!wantsFourKDiscovery(options.preferredHeight)) return null;
  if (sourceMaxHeight(current) >= UHD_HEIGHT) return null;

  const failed =
    options.failedIds instanceof Set
      ? options.failedIds
      : new Set(options.failedIds ?? []);

  const pool = sources.filter((source) => {
    if (failed.has(source.id)) return false;
    if (source.verified === false) return false;
    if (!isSourcePlayableHere(source)) return false;
    if (sourceMaxHeight(source) < UHD_HEIGHT) return false;
    if (source.probe?.ok === false) return false;
    return sourceDelivery(source) !== "unavailable";
  });
  if (!pool.length) return null;

  const direct = pool.filter((source) => sourceDelivery(source) === "direct");
  const ranked = pickDefaultSource(
    direct.length ? direct : pool,
    options.preferredProvider,
    UHD_HEIGHT
  );
  if (!ranked || ranked.id === current.id) return null;
  if (sourceMaxHeight(ranked) < UHD_HEIGHT) return null;
  return ranked;
}
