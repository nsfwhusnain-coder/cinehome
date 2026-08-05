import { isTvLikeDevice } from "./tv-detect";

export type SpatialDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** Detection lives in tv-detect.ts now; re-exported so callers keep one import. */
export { isTvLikeDevice };

/**
 * Whether a key event is the remote's Back button.
 *
 * webOS sends keyCode 461, Tizen sends 10009, and Chromium-based panels send a
 * named key. Both handlers used to test 461 and "GoBack" only, so Back did
 * nothing at all on every Samsung set — in the player as well as outside it,
 * since the player owns its own map. Back is the first control a viewer
 * reaches for, and a set that ignores it reads as having frozen.
 *
 * Escape is deliberately excluded: it is how dialogs and the settings dock
 * close, and treating it as Back would navigate away instead of closing them.
 */
export function isRemoteBackEvent(
  event: Pick<KeyboardEvent, "key" | "keyCode">
): boolean {
  return (
    event.keyCode === 461 ||
    event.keyCode === 10009 ||
    event.key === "GoBack" ||
    event.key === "BrowserBack"
  );
}

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

/**
 * Candidates are culled to the viewport grown by this many screens along the
 * axis of travel.
 *
 * Without it every arrow press measured every focusable element on the page.
 * A catalogue hub carries several hundred card links, and the old
 * implementation called getComputedStyle *and* getBoundingClientRect on each
 * one, per keypress — hundreds of forced style-and-layout passes for a single
 * D-pad tap, on the weakest CPU the app ever runs on. That is the whole of why
 * the remote felt like it was ignoring presses: the work was synchronous and
 * landed between the key event and the paint.
 *
 * One screen ahead is enough to reach the next row or column while it is still
 * off-screen, which is the only case culling could otherwise break.
 */
const SEARCH_BAND_SCREENS = 1;

/** Candidates must clear the current element's edge by more than this to count. */
const EDGE_TOLERANCE_PX = 4;

/** Cross-axis separation costs this much per pixel against primary distance. */
const MISALIGNMENT_PENALTY = 3;

interface Candidate {
  element: HTMLElement;
  rect: DOMRect;
}

/**
 * `checkVisibility()` is a single native call that answers what the old
 * getComputedStyle round-trip answered, without materialising a style
 * declaration per element. The typings mark it as always present; the runtime
 * guard is for the older living-room engines that predate it, where the rect
 * test alone still catches `display: none` (zero box) — the case that actually
 * occurs here.
 */
function isRenderedAtRect(element: HTMLElement, rect: DOMRect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof element.checkVisibility !== "function") return true;
  return element.checkVisibility({ checkVisibilityCSS: true });
}

/**
 * Every focusable element currently rendered. Kept for callers that genuinely
 * need the whole set (bootstrapping focus); the spatial search deliberately
 * does not use it, because measuring the whole document is the cost being
 * avoided.
 */
export function focusableElements(root: ParentNode = document): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return found.filter(
    (element) =>
      !element.closest("[aria-hidden='true']") &&
      isRenderedAtRect(element, element.getBoundingClientRect())
  );
}

/** Viewport box grown by one screen along the axis of travel. */
function searchBand(direction: SpatialDirection): DOMRect {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const growX = direction === "ArrowLeft" || direction === "ArrowRight";
  const padX = growX ? width * SEARCH_BAND_SCREENS : 0;
  const padY = growX ? 0 : height * SEARCH_BAND_SCREENS;
  return new DOMRect(-padX, -padY, width + padX * 2, height + padY * 2);
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

/**
 * One pass: query, measure, cull. The first getBoundingClientRect flushes
 * layout and the rest read a clean tree, so this is a single layout pass rather
 * than one per element.
 */
function candidatesInBand(
  root: ParentNode,
  current: HTMLElement,
  direction: SpatialDirection
): Candidate[] {
  const band = searchBand(direction);
  const found = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const candidates: Candidate[] = [];
  for (const element of found) {
    if (element === current) continue;
    const rect = element.getBoundingClientRect();
    if (!intersects(rect, band)) continue;
    if (!isRenderedAtRect(element, rect)) continue;
    if (element.closest("[aria-hidden='true']")) continue;
    candidates.push({ element, rect });
  }
  return candidates;
}

/**
 * Distance past the current element's trailing edge; negative means behind it.
 * Exported for tests — the scoring is the whole of the navigation feel, and it
 * is pure geometry that deserves checking without a DOM.
 */
export function primaryGap(
  current: DOMRect,
  candidate: DOMRect,
  direction: SpatialDirection
): number {
  switch (direction) {
    case "ArrowLeft":
      return current.left - candidate.right;
    case "ArrowRight":
      return candidate.left - current.right;
    case "ArrowUp":
      return current.top - candidate.bottom;
    default:
      return candidate.top - current.bottom;
  }
}

/**
 * Cross-axis separation: zero whenever the two boxes share any extent on the
 * perpendicular axis, and the size of the gap otherwise.
 *
 * Overlap rather than centre distance is what makes a grid behave. Centres put
 * a tall hero and the short card beside it far apart on the cross axis even
 * though they plainly sit in the same row, so pressing Right would skip the
 * neighbour for something further away that happened to be better centred.
 */
export function crossGap(
  current: DOMRect,
  candidate: DOMRect,
  direction: SpatialDirection
): number {
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  const currentStart = horizontal ? current.top : current.left;
  const currentEnd = horizontal ? current.bottom : current.right;
  const candidateStart = horizontal ? candidate.top : candidate.left;
  const candidateEnd = horizontal ? candidate.bottom : candidate.right;
  if (candidateEnd > currentStart && candidateStart < currentEnd) return 0;
  return candidateStart >= currentEnd
    ? candidateStart - currentEnd
    : currentStart - candidateEnd;
}

/**
 * Geometry-based focus movement for TV remotes. Candidates must clear the
 * current element's edge in the requested direction; among those, the nearest
 * one still aligned with the current row or column wins.
 */
export function spatialTarget(
  root: ParentNode,
  current: HTMLElement,
  direction: SpatialDirection
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  let best: { element: HTMLElement; score: number } | null = null;

  for (const { element, rect } of candidatesInBand(root, current, direction)) {
    const primary = primaryGap(currentRect, rect, direction);
    if (primary < -EDGE_TOLERANCE_PX) continue;
    const score = Math.max(primary, 0) + crossGap(currentRect, rect, direction) * MISALIGNMENT_PENALTY;
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
