import { isSourcePlayableHere, sourceMaxHeight } from "./source-quality";
import type { PlaybackResponse } from "./types";

/**
 * Ultra may wait this long for 4K AFTER a playable stream already exists.
 * Then start the best source we have (1080 / 720 / 480).
 */
export const ULTRA_STARTUP_HOLD_MS = 60_000;

export interface MaximumStartupGate {
  target: string;
  released: boolean;
}

export function isPlayableStartupSource(
  source: NonNullable<PlaybackResponse["sources"]>[number]
): boolean {
  if (source.verified === false || source.probe?.ok === false) return false;
  return isSourcePlayableHere(source);
}

export function hasPlayableAnyQuality(response: PlaybackResponse): boolean {
  return (response.sources ?? []).some(isPlayableStartupSource);
}

export function hasPlayablePreferredQuality(response: PlaybackResponse): boolean {
  const preferred = response.preferences?.playbackQuality;
  if (typeof preferred !== "number") return true;
  return (response.sources ?? []).some((source) => {
    if (!isPlayableStartupSource(source)) return false;
    return sourceMaxHeight(source) >= preferred;
  });
}

export function preferredQualityDiscoveryPending(
  response: PlaybackResponse | undefined
): boolean {
  if (!response?.partial) return false;
  const preferred = response.preferences?.playbackQuality;
  if (typeof preferred !== "number" || preferred <= 1080) return false;
  return !hasPlayablePreferredQuality(response);
}

export function shouldWaitForMaximumFourK(
  response: PlaybackResponse | undefined,
  discoveryOpen: boolean,
  startupReleased = false
): boolean {
  if (!response || !discoveryOpen || startupReleased) return false;
  if (response.preferences?.playbackQuality !== 2160) return false;
  // Nothing to fall back to yet — do not hide an empty roster behind a 4K wait.
  if (!hasPlayableAnyQuality(response)) return false;
  return !hasPlayablePreferredQuality(response);
}

export function advanceMaximumStartupGate(
  state: MaximumStartupGate,
  target: string,
  response: PlaybackResponse | undefined,
  holdStartup: boolean
): MaximumStartupGate {
  if (state.target !== target) return { target, released: false };
  if (state.released || !response || holdStartup) return state;
  return { target, released: true };
}
