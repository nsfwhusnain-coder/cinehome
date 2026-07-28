import { isPoisonStreamUrl } from "./poison-url";

export interface RosterHealthSource {
  url: string;
  verified?: boolean;
  probe?: { ok?: boolean };
}

export function countAutoPlayableRosterSources(
  sources: RosterHealthSource[]
): number {
  return sources.filter(
    (source) =>
      source.verified !== false &&
      source.probe?.ok !== false &&
      !isPoisonStreamUrl(source.url)
  ).length;
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
