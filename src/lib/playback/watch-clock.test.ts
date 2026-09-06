/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  createWatchClock,
  flushWatch,
  MAX_TICK_MS,
  startWatching,
  stopWatching,
  watchedMs,
} from "./watch-clock";

const T0 = 1_000_000;

describe("watch-clock", () => {
  it("counts nothing before playback starts", () => {
    expect(watchedMs(createWatchClock(), T0)).toBe(0);
  });

  it("counts time while rendering", () => {
    const clock = startWatching(createWatchClock(), "quasar", T0);
    expect(watchedMs(clock, T0 + 5_000)).toBe(5_000);
  });

  it("stops counting while paused or buffering", () => {
    let clock = startWatching(createWatchClock(), "quasar", T0);
    clock = stopWatching(clock, T0 + 5_000);
    // Ten more seconds pass with the video paused.
    expect(watchedMs(clock, T0 + 15_000)).toBe(5_000);
  });

  it("resumes accumulating after a pause", () => {
    let clock = startWatching(createWatchClock(), "quasar", T0);
    clock = stopWatching(clock, T0 + 5_000);
    clock = startWatching(clock, "quasar", T0 + 15_000);
    expect(watchedMs(clock, T0 + 20_000)).toBe(10_000);
  });

  it("is idempotent — a repeated play event does not restart the tick", () => {
    let clock = startWatching(createWatchClock(), "quasar", T0);
    clock = startWatching(clock, "quasar", T0 + 3_000);
    expect(watchedMs(clock, T0 + 5_000)).toBe(5_000);
  });

  it("discards an implausible tick from a slept machine", () => {
    const clock = startWatching(createWatchClock(), "quasar", T0);
    expect(watchedMs(clock, T0 + MAX_TICK_MS * 4)).toBe(MAX_TICK_MS);
  });

  it("resets when the source changes, never crediting the new source", () => {
    let clock = startWatching(createWatchClock(), "quasar", T0);
    clock = startWatching(clock, "luna", T0 + 60_000);
    expect(watchedMs(clock, T0 + 61_000)).toBe(1_000);
  });

  it("flushes what a source earned and clears itself", () => {
    const clock = startWatching(createWatchClock(), "quasar", T0);
    const { flushed, next } = flushWatch(clock, T0 + 90_000);
    expect(flushed).toEqual({ sourceId: "quasar", watchedMs: 90_000 });
    expect(next.sourceId).toBeNull();
    expect(watchedMs(next, T0 + 90_000)).toBe(0);
  });

  it("flushes nothing when a source never rendered", () => {
    expect(flushWatch(createWatchClock(), T0).flushed).toBeNull();
  });

  it("flushes a paused source using its settled total", () => {
    let clock = startWatching(createWatchClock(), "quasar", T0);
    clock = stopWatching(clock, T0 + 30_000);
    expect(flushWatch(clock, T0 + 99_000).flushed).toEqual({
      sourceId: "quasar",
      watchedMs: 30_000,
    });
  });
});
