"use client";

import { useEffect } from "react";
import {
  focusableElements,
  isTvLikeDevice,
  moveSpatialFocus,
  type SpatialDirection,
} from "@/lib/tv-navigation";

const ARROWS = new Set<SpatialDirection>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function TvSpatialNavigation() {
  useEffect(() => {
    if (!isTvLikeDevice()) return;
    document.documentElement.dataset.tv = "1";

    const onKeyDown = (event: KeyboardEvent) => {
      // The player owns its own remote map, including media and Back keys.
      if ((event.target as Element | null)?.closest(".player-shell")) return;

      const isBack = event.keyCode === 461 || event.key === "GoBack";
      if (isBack) {
        event.preventDefault();
        window.history.back();
        return;
      }
      if (!ARROWS.has(event.key as SpatialDirection)) return;

      const direction = event.key as SpatialDirection;
      const current = document.activeElement as HTMLElement | null;
      if (!current || current === document.body || !document.documentElement.contains(current)) {
        const first = focusableElements(document)[0];
        if (first) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (moveSpatialFocus(document, current, direction)) event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      delete document.documentElement.dataset.tv;
    };
  }, []);

  return null;
}
