"use client";

import { usePlayerStore } from "@/stores/player-store";

/** Blind seek window — there is no real intro-marker data upstream. */
const SKIP_WINDOW_START_S = 30;
const SKIP_WINDOW_END_S = 90;
/** Hide entirely on short-form content where a fixed 90s jump makes no sense. */
const SKIP_MIN_DURATION_S = 600;

interface Props {
  onSkip: (time: number) => void;
}

/**
 * Honest relabel of the old "Skip Intro" button: this always jumps to a fixed
 * 90s mark (no real per-title intro detection exists), so it no longer claims
 * otherwise, and hides on sub-10-minute content where the jump is nonsensical.
 *
 * Isolated in its own component with its own zustand subscription so the
 * 250ms currentTime tick only re-renders this small subtree, not the whole
 * VideoPlayer tree (see video-player.tsx task 8 notes).
 */
export function SkipIntroButton({ onSkip }: Props) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);

  const visible =
    duration >= SKIP_MIN_DURATION_S &&
    currentTime >= SKIP_WINDOW_START_S &&
    currentTime < SKIP_WINDOW_END_S;

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => onSkip(SKIP_WINDOW_END_S)}
      className="absolute bottom-24 right-4 z-10 flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-white/20"
    >
      Skip 90s
    </button>
  );
}
