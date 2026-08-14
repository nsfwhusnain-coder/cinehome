"use client";

import { useCallback, useRef, useState } from "react";
import {
  reducePlaybackPhase,
  type PlaybackPhase,
  type PlaybackSessionEvent,
} from "@/lib/playback/playback-session";

export function usePlaybackSession(initial: PlaybackPhase = "idle") {
  const [phase, setPhase] = useState<PlaybackPhase>(initial);
  const phaseRef = useRef<PlaybackPhase>(initial);

  const dispatch = useCallback((event: PlaybackSessionEvent) => {
    const next = reducePlaybackPhase(phaseRef.current, event);
    if (next === phaseRef.current) return next;
    phaseRef.current = next;
    setPhase(next);
    return next;
  }, []);

  return { phase, phaseRef, dispatch };
}
