import { isSourcePlayableHere, sourceMaxHeight } from "./source-quality";
import type { PlaybackResponse } from "./types";

export interface MaximumStartupGate {
  target: string;
  released: boolean;
}

function hasPlayablePreferredQuality(response: PlaybackResponse): boolean {
  const preferred = response.preferences?.playbackQuality;
  if (typeof preferred !== "number") return true;
  return (response.sources ?? []).some(
    (source) =>
      source.verified !== false &&
      source.probe?.ok !== false &&
      isSourcePlayableHere(source) &&
      sourceMaxHeight(source) >= preferred
  );
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
  return (
    response.preferences?.playbackQuality === 2160 &&
    response.preferences.fourKStartup === "maximum" &&
    !hasPlayablePreferredQuality(response)
  );
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
