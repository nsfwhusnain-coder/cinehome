import { describe, expect, it } from "bun:test";
import { crossGap, isRemoteBackEvent, primaryGap } from "./tv-navigation";

/**
 * DOMRect is not available without a DOM, and only the six edge properties are
 * read. A literal keeps these tests pure, which is the point of splitting the
 * geometry out of the element walk.
 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A card in a horizontal rail: 300 wide, 170 tall, 20px gutter. */
const CARD_W = 300;
const CARD_H = 170;
const GUTTER = 20;
const card = (column: number, row: number) =>
  rect(column * (CARD_W + GUTTER), row * (CARD_H + GUTTER), CARD_W, CARD_H);

describe("isRemoteBackEvent", () => {
  it("recognises Back on every platform that sends it", () => {
    expect(isRemoteBackEvent({ key: "", keyCode: 461 })).toBe(true); // webOS
    expect(isRemoteBackEvent({ key: "", keyCode: 10009 })).toBe(true); // Tizen
    expect(isRemoteBackEvent({ key: "GoBack", keyCode: 0 })).toBe(true);
    expect(isRemoteBackEvent({ key: "BrowserBack", keyCode: 0 })).toBe(true);
  });

  it("leaves Escape alone", () => {
    // Escape closes dialogs and the settings dock. Treating it as Back would
    // navigate away from the page instead of closing what is open on it.
    expect(isRemoteBackEvent({ key: "Escape", keyCode: 27 })).toBe(false);
  });

  it("ignores ordinary keys", () => {
    expect(isRemoteBackEvent({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(isRemoteBackEvent({ key: "ArrowLeft", keyCode: 37 })).toBe(false);
  });
});

describe("primaryGap", () => {
  const current = card(1, 1);

  it("measures the gap to the next card in each direction", () => {
    expect(primaryGap(current, card(2, 1), "ArrowRight")).toBe(GUTTER);
    expect(primaryGap(current, card(0, 1), "ArrowLeft")).toBe(GUTTER);
    expect(primaryGap(current, card(1, 2), "ArrowDown")).toBe(GUTTER);
    expect(primaryGap(current, card(1, 0), "ArrowUp")).toBe(GUTTER);
  });

  it("reports a negative gap for a candidate behind the direction of travel", () => {
    // The caller rejects these; pressing Right must never select something to
    // the left, however close it happens to be.
    expect(primaryGap(current, card(0, 1), "ArrowRight")).toBeLessThan(0);
    expect(primaryGap(current, card(1, 0), "ArrowDown")).toBeLessThan(0);
  });

  it("measures from the edges, not the centres", () => {
    // A tall hero beside a short card: centre-based measurement would put these
    // far apart on the primary axis even though they are edge to edge.
    const hero = rect(0, 0, 600, 600);
    const neighbour = rect(620, 250, CARD_W, CARD_H);
    expect(primaryGap(hero, neighbour, "ArrowRight")).toBe(20);
  });
});

describe("crossGap", () => {
  it("is zero for anything sharing extent on the perpendicular axis", () => {
    const current = card(1, 1);
    expect(crossGap(current, card(2, 1), "ArrowRight")).toBe(0);
    expect(crossGap(current, card(5, 1), "ArrowRight")).toBe(0);
    expect(crossGap(current, card(1, 2), "ArrowDown")).toBe(0);
  });

  it("is zero for a partial overlap", () => {
    // A rail whose rows are not perfectly aligned still reads as one row.
    const current = rect(0, 0, CARD_W, CARD_H);
    const offset = rect(320, 150, CARD_W, CARD_H);
    expect(crossGap(current, offset, "ArrowRight")).toBe(0);
  });

  it("measures the separation when the boxes share no extent", () => {
    const current = card(1, 1);
    expect(crossGap(current, card(2, 2), "ArrowRight")).toBe(GUTTER);
    expect(crossGap(current, card(2, 0), "ArrowRight")).toBe(GUTTER);
  });

  it("keeps a neighbour in the same row ahead of a nearer one in the next", () => {
    // This is the ordering the scorer depends on: pressing Right along a rail
    // must not drop into the row below merely because it is closer in raw
    // distance. Overlap decides it, and only the aligned card scores zero.
    const current = card(1, 1);
    const sameRow = card(2, 1);
    const nextRow = card(1, 2);
    expect(crossGap(current, sameRow, "ArrowRight")).toBe(0);
    expect(crossGap(current, nextRow, "ArrowRight")).toBeGreaterThan(0);
  });
});
