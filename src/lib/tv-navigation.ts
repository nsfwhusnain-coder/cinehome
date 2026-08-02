export type SpatialDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

const TV_USER_AGENT =
  /(?:web0s|webos|tizen|smart[- ]?tv|netcast|bravia|hbbtv|viera|aquos|aft(?:b|m|s|t)|crkey)/i;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[role='button']:not([aria-disabled='true'])",
  "[role='slider']:not([aria-disabled='true'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function isTvLikeDevice(): boolean {
  if (typeof window === "undefined") return false;
  const forced = new URLSearchParams(window.location.search).get("tv");
  if (forced === "1") return true;
  if (forced === "0") return false;
  return TV_USER_AGENT.test(window.navigator.userAgent);
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function focusableElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.closest("[aria-hidden='true']") && isVisible(element)
  );
}

/**
 * Geometry-based focus movement for TV remotes. It favours candidates in the
 * requested direction, then the one most closely aligned with the current row
 * or column. This works across grids without every page owning a key map.
 */
export function spatialTarget(
  root: ParentNode,
  current: HTMLElement,
  direction: SpatialDirection
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  const cx = currentRect.left + currentRect.width / 2;
  const cy = currentRect.top + currentRect.height / 2;
  let best: { element: HTMLElement; score: number } | null = null;

  for (const element of focusableElements(root)) {
    if (element === current) continue;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const primary =
      direction === "ArrowLeft"
        ? -dx
        : direction === "ArrowRight"
          ? dx
          : direction === "ArrowUp"
            ? -dy
            : dy;
    if (primary <= 4) continue;
    const cross =
      direction === "ArrowLeft" || direction === "ArrowRight"
        ? Math.abs(dy)
        : Math.abs(dx);
    // Penalise off-axis candidates heavily while still allowing a move out of
    // an incomplete row or column.
    const score = primary + cross * 2.5;
    if (!best || score < best.score) best = { element, score };
  }

  return best?.element ?? null;
}

export function moveSpatialFocus(
  root: ParentNode,
  current: HTMLElement,
  direction: SpatialDirection
): boolean {
  const next = spatialTarget(root, current, direction);
  if (!next) return false;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  return true;
}

