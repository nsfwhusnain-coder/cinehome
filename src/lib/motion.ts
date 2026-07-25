// Shared Framer Motion constants — single source of truth so easing/timing
// can't drift between components the way it did before this file existed.
import type { Transition } from "framer-motion";

/** Content fade-ins / page transitions (cubic-bezier ease-out-expo). */
export const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const DURATION_FAST = 0.25; // card/item staggers
export const DURATION_CONTENT = 0.3; // content fade-ins, section reveals
export const DURATION_VIEW = 0.35; // page-level transitions
export const DURATION_ENTER = 0.4; // auth/settings entry
export const DURATION_HERO = 0.5; // hero content crossfade

/** Ready-made transitions for common cases — prefer these over inline objects. */
export const transitionFast: Transition = {
  duration: DURATION_FAST,
  ease: EASE_OUT_EXPO,
};

export const transitionContent: Transition = {
  duration: DURATION_CONTENT,
  ease: EASE_OUT_EXPO,
};

export const transitionView: Transition = {
  duration: DURATION_VIEW,
  ease: EASE_OUT_EXPO,
};

export const transitionEnter: Transition = {
  duration: DURATION_ENTER,
  ease: EASE_OUT_EXPO,
};

export const transitionHero: Transition = {
  duration: DURATION_HERO,
  ease: EASE_OUT_EXPO,
};
