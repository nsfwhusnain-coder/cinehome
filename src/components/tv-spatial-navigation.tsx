"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  focusableElements,
  isRemoteBackEvent,
  isTvLikeDevice,
  spatialTarget,
  type SpatialDirection,
} from "@/lib/tv-navigation";

const ARROWS = new Set<SpatialDirection>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

/**
 * Two D-pad moves closer together than this are a held button rather than two
 * decisions, and the scroll drops to instant for them. Smooth scrolling is
 * worth the cost for a single press; under repeat it queues one animation per
 * press on a CPU that is already the bottleneck, and focus visibly lags behind
 * the remote.
 */
const HELD_REPEAT_MS = 250;

export function TvSpatialNavigation() {
  const pathname = usePathname();

  useEffect(() => {
    if (!isTvLikeDevice()) return;
    // The head script normally set this before the first paint; assigning it
    // again is harmless and covers the case where that script was blocked.
    document.documentElement.dataset.tv = "1";

    let movedThisFrame = false;
    let frameHandle = 0;
    let lastMoveAt = 0;

    const move = (current: HTMLElement, direction: SpatialDirection): boolean => {
      const next = spatialTarget(document, current, direction);
      if (!next) return false;
      const now = performance.now();
      const held = now - lastMoveAt < HELD_REPEAT_MS;
      lastMoveAt = now;
      next.focus({ preventScroll: true });
      // "instant", not "auto": `auto` defers to CSS, and html[data-tv="1"]
      // sets scroll-behavior: smooth, so `auto` would quietly stay smooth and
      // the repeat case would get no relief at all.
      next.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: held ? "instant" : "smooth",
      });
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // The player owns its own remote map, including media and Back keys.
      if ((event.target as Element | null)?.closest(".player-shell")) return;

      if (isRemoteBackEvent(event)) {
        event.preventDefault();
        window.history.back();
        return;
      }

      // A remote's OK button lands as Enter. Native activation covers buttons
      // and links; elements that are only ARIA buttons need the click synthesised
      // or OK does nothing on them.
      if (event.key === "Enter") {
        const target = event.target as HTMLElement | null;
        const role = target?.getAttribute("role");
        if (target && role === "button" && target.tagName !== "BUTTON") {
          event.preventDefault();
          target.click();
        }
        return;
      }

      if (!ARROWS.has(event.key as SpatialDirection)) return;

      // One move per frame. A held D-pad fires far faster than the panel can
      // paint, and without this each repeat queued another full spatial search
      // between the key event and a frame that never got a chance to render.
      if (movedThisFrame) {
        event.preventDefault();
        return;
      }

      const direction = event.key as SpatialDirection;
      const current = document.activeElement as HTMLElement | null;
      const hasFocus =
        current &&
        current !== document.body &&
        document.documentElement.contains(current);

      if (!hasFocus) {
        const first = focusableElements(document)[0];
        if (first) {
          event.preventDefault();
          first.focus();
          first.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
        return;
      }

      if (move(current, direction)) {
        event.preventDefault();
        movedThisFrame = true;
        frameHandle = window.requestAnimationFrame(() => {
          movedThisFrame = false;
          frameHandle = 0;
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (frameHandle) window.cancelAnimationFrame(frameHandle);
      delete document.documentElement.dataset.tv;
    };
  }, []);

  /**
   * Give every new page a focused element.
   *
   * Client navigation leaves focus on document.body, so arriving anywhere new
   * showed no focus ring at all and the first press of the remote was spent
   * bootstrapping rather than moving. Only claims focus when nothing else holds
   * it, so it can never pull focus out from under a viewer mid-interaction.
   */
  useEffect(() => {
    if (!isTvLikeDevice()) return;
    const handle = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const main = document.querySelector("main") ?? document;
      const first = focusableElements(main)[0];
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [pathname]);

  return null;
}
