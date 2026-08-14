import { VERIFIED_MIN_SKIP_SECONDARY } from "./embed-roster";
import { isNeverAutoDefaultUrl } from "./poison-url";

export interface RosterHealthSource {
  url: string;
  verified?: boolean;
  probe?: { ok?: boolean };
  maxHeight?: number;
  ladder?: number[];
}

function isAutoPlayable(source: RosterHealthSource): boolean {
  return (
    source.verified !== false &&
    source.probe?.ok !== false &&
    !isNeverAutoDefaultUrl(source.url)
  );
}

export function countAutoPlayableRosterSources(
  sources: RosterHealthSource[]
): number {
  return sources.filter(
    (source) => isAutoPlayable(source)
  ).length;
}

export function rosterHasPlayableHeight(
  sources: RosterHealthSource[],
  targetHeight: number
): boolean {
  return sources.some((source) => {
    if (!isAutoPlayable(source)) return false;
    const ladderTop = source.ladder?.[0] ?? 0;
    return Math.max(source.maxHeight ?? 0, ladderTop) >= targetHeight;
  });
}

/** Strict health evidence used before deciding that fallback providers may stop. */
export function countMeasuredPlayableRosterSources(
  sources: RosterHealthSource[]
): number {
  return sources.filter(
    (source) =>
      (source.verified === true || source.probe?.ok === true) &&
      source.verified !== false &&
      source.probe?.ok !== false &&
      !isNeverAutoDefaultUrl(source.url)
  ).length;
}

export function partialForPlayableRoster(
  sources: RosterHealthSource[],
  clearAt: number
): true | undefined {
  return countAutoPlayableRosterSources(sources) < clearAt ? true : undefined;
}

/**
 * Skip BOTH Playwright waves when the API roster is already healthy.
 * Vidking PW is often ~17s (over the per-embed budget) and burns the only
 * browser (BROWSER_POOL_SIZE=1). Witcher S1E1 measured Luna + Quasar +
 * Rock×3 in 921ms fast / 14s full — four measured-playable APIs make PW
 * unnecessary. Threshold is VERIFIED_MIN_SKIP_SECONDARY (4).
 */
export function shouldSkipPlaywrightForHealthyRoster(
  sources: RosterHealthSource[]
): boolean {
  return (
    countMeasuredPlayableRosterSources(sources) >= VERIFIED_MIN_SKIP_SECONDARY
  );
}
