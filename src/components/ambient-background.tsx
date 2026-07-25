"use client";

import { useEffect, useState } from "react";
import { useAmbientStore } from "@/stores/ambient-store";

const CANVAS = "#0a0a0f";

/**
 * LordFlix-style wash under the hero: tintTop → canvas over a long falloff
 * so Continue Watching / first rails sit in a clean colored gradient.
 * Crossfade ~600ms. Never mounts inside the hero.
 */
export function AmbientBackground() {
  const color = useAmbientStore((s) => s.color) ?? CANVAS;
  const [a, setA] = useState(CANVAS);
  const [b, setB] = useState(CANVAS);
  const [showB, setShowB] = useState(false);

  useEffect(() => {
    const next = color || CANVAS;
    if (showB) {
      if (next === b) return;
      setA(next);
      setShowB(false);
    } else {
      if (next === a) return;
      setB(next);
      setShowB(true);
    }
  }, [color, a, b, showB]);

  const layer = (tint: string, opacity: number) => (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0"
      style={{
        // Long enough that rails sit in the wash; soft stop into canvas
        height: "min(1400px, 160vh)",
        opacity,
        transition: "opacity 600ms ease",
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
