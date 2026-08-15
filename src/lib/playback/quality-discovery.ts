import {
  isSourcePlayableHere,
  sourceDelivery,
  sourceMaxHeight,
} from "./source-quality";
import type { PlaybackResponse } from "./types";

/** Ultra may wait this long for 4K. After this, start the best source once. */
export const ULTRA_STARTUP_HOLD_MS = 45_000;

export interface MaximumStartupGate {
  target: string;
  released: boolean;
}

export function hasPlayablePreferredQuality(response: PlaybackResponse): boolean {
  const preferred = response.preferences?.playbackQuality;
  if (typeof preferred !== "number") return true;
  return (response.sources ?? []).some((source) => {
    if (source.verified === false || source.probe?.ok === false) return false;
    if (!isSourcePlayableHere(source)) return false;
    if (sourceMaxHeight(source) < preferred) return false;
    // Remux 4K is not a reason to keep the title card up — it packs later.
    if (preferred >= 2160 && sourceDelivery(source) !== "direct") return false;
    return true;
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
