"use client";

import { useState } from "react";
import { useAmbientStore } from "@/stores/ambient-store";

const CANVAS = "#0a0a0f";

/**
 * LordFlix-style wash under the hero: tintTop → canvas over a long falloff
 * so Continue Watching / first rails sit in a clean colored gradient.
 * Crossfade ~600ms. Never mounts inside the hero.
 */
export function AmbientBackground() {
  const color = useAmbientStore((s) => s.color) ?? CANVAS;
  const next = color || CANVAS;
  /**
   * Two tint layers that alternate: whichever is hidden takes the incoming
   * colour, then becomes the visible one, so opacity crosses between them.
   *
   * `seen` is the colour this pair was last built for. Comparing it during
   * render and adjusting state right there is React's documented way to react
   * to a changed input — an effect would do the same work a paint later, which
   * is both what the compiler flags and a wasted frame. The crossfade is
   * unaffected: the incoming layer still gets its new tint and its opacity in
   * the same commit, which is exactly what the effect used to do.
   */
  const [fade, setFade] = useState({
    a: CANVAS,
    b: CANVAS,
    showB: false,
    seen: CANVAS,
  });
  if (next !== fade.seen) {
    setFade(
      fade.showB
        ? { ...fade, a: next, showB: false, seen: next }
        : { ...fade, b: next, showB: true, seen: next }
    );
  }
  const { a, b, showB } = fade;

  const layer = (tint: string, opacity: number) => (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0"
      style={{
        // Long enough that rails sit in the wash; soft stop into canvas
        height: "min(1400px, 160vh)",
        opacity,
        transition: "opacity 900ms cubic-bezier(0.16, 1, 0.3, 1)",
        background: `linear-gradient(180deg, ${tint} 0%, ${tint} 18%, ${CANVAS} 72%, ${CANVAS} 100%)`,
      }}
    />
  );

  return (
    <div aria-hidden className="absolute inset-0 z-0" style={{ backgroundColor: CANVAS }}>
      {layer(a, showB ? 0 : 1)}
      {layer(b, showB ? 1 : 0)}
    </div>
  );
}
