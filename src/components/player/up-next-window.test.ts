/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { shouldShowUpNext } from "./up-next-window";

/**
 * A blind heuristic — nothing upstream marks where credits start — so what
 * matters is that it never fires early and never fires on content where a
 * fixed tail makes no sense.
 */
describe("shouldShowUpNext", () => {
  const HOUR = 3600;

  it("stays hidden through the body of an episode", () => {
    expect(shouldShowUpNext(0, HOUR)).toBe(false);
    expect(shouldShowUpNext(HOUR / 2, HOUR)).toBe(false);
    expect(shouldShowUpNext(HOUR - 120, HOUR)).toBe(false);
  });

  it("appears inside the tail window and stays up to the end", () => {
    expect(shouldShowUpNext(HOUR - 74, HOUR)).toBe(true);
    expect(shouldShowUpNext(HOUR, HOUR)).toBe(true);
  });

  it("never fires on short content, where the tail would be most of the runtime", () => {
    expect(shouldShowUpNext(299, 300)).toBe(false);
  });

  it("never fires before duration is known", () => {
    expect(shouldShowUpNext(0, 0)).toBe(false);
    expect(shouldShowUpNext(5, 0)).toBe(false);
    expect(shouldShowUpNext(5, Number.NaN)).toBe(false);
  });

  it("ignores a still-growing duration rather than firing an episode early", () => {
    // A remux 20s into a 24-minute episode reported duration 491.9s. Trusting
    // it would put the card an entire episode early.
    expect(shouldShowUpNext(480, 491.9, true)).toBe(false);
    expect(shouldShowUpNext(480, 491.9, false)).toBe(true);
  });

  it("falls back to TMDB's runtime while the stream's own duration is growing", () => {
    const runtime = 24 * 60;
    // Same provisional stream, but now we know how long the episode really is.
    expect(shouldShowUpNext(480, 491.9, true, runtime)).toBe(false);
    expect(shouldShowUpNext(runtime - 30, 491.9, true, runtime)).toBe(true);
  });

  it("does not use the fallback once the real duration is known", () => {
    // A wrong fallback must never override a duration the stream itself states.
    expect(shouldShowUpNext(100, HOUR, false, 200)).toBe(false);
  });
});
