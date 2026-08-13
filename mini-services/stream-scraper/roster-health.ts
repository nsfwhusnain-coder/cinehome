import { isPoisonStreamUrl } from "./poison-url";

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
    !isPoisonStreamUrl(source.url)
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
      !isPoisonStreamUrl(source.url)
  ).length;
}

export function partialForPlayableRoster(
  sources: RosterHealthSource[],
  clearAt: number
): true | undefined {
  return countAutoPlayableRosterSources(sources) < clearAt ? true : undefined;
}
