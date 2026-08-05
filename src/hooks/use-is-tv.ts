"use client";

import { useSyncExternalStore } from "react";
import { isTvLikeDevice } from "@/lib/tv-detect";

/** The device class cannot change mid-session, so there is nothing to subscribe to. */
function subscribe(): () => void {
  return () => {};
}

function serverSnapshot(): boolean {
  return false;
}

/**
 * Whether this session is running on a television, for components that need to
 * render differently rather than merely style differently.
 *
 * Detection needs `window`, so a server render can never agree with a client
 * render that consulted it. useSyncExternalStore is the primitive built for
 * exactly that split: it hydrates against the server snapshot, so the two
 * trees match, then re-renders with the real value. A television therefore
 * pays one frame of the animation it is about to stop running, and nothing
 * mismatches.
 *
 * Anything expressible in CSS should use the `html[data-tv="1"]` marker
 * instead, which the head script sets before the first paint.
 */
export function useIsTv(): boolean {
  return useSyncExternalStore(subscribe, isTvLikeDevice, serverSnapshot);
}
