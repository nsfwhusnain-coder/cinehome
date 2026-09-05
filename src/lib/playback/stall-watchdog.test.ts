/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  STALL_MIN_ADVANCE_S,
  hasStreamProgress,
  stallThresholdMs,
} from "./stall-watchdog";

const BASE = 12_000;
const POST_SEEK = 30_000;
const GRACE = 45_000;

describe("hasStreamProgress", () => {
  it("counts a moving playhead as progress", () => {
    expect(
      hasStreamProgress({
        baselinePositionS: 100,
        baselineBufferedEndS: 120,
        positionS: 103,
        bufferedEndS: 120,
      })
    ).toBe(true);
  });

  it("counts a filling buffer as progress even while the playhead is frozen", () => {
    // The regression: seeking into a cold 4K region holds currentTime still
    // while segments download. That is a working source, not a dead one.
    expect(
      hasStreamProgress({
        baselinePositionS: 1800,
        baselineBufferedEndS: 1800,
        positionS: 1800,
        bufferedEndS: 1806,
      })
    ).toBe(true);
  });

  it("reports no progress when neither the playhead nor the buffer moves", () => {
    expect(
      hasStreamProgress({
        baselinePositionS: 1800,
        baselineBufferedEndS: 1812,
        positionS: 1800,
        bufferedEndS: 1812,
      })
    ).toBe(false);
  });

  it("ignores jitter below the minimum advance", () => {
    const jitter = STALL_MIN_ADVANCE_S / 2;
    expect(
      hasStreamProgress({
        baselinePositionS: 10,
        baselineBufferedEndS: 30,
        positionS: 10 + jitter,
        bufferedEndS: 30 + jitter,
      })
    ).toBe(false);
  });

  it("does not treat a shrinking buffer as progress", () => {
    // hls.js evicting back-buffer must never read as liveness.
    expect(
      hasStreamProgress({
        baselinePositionS: 500,
        baselineBufferedEndS: 560,
        positionS: 500,
        bufferedEndS: 540,
      })
    ).toBe(false);
  });
});

describe("stallThresholdMs", () => {
  it("uses the engine threshold during steady-state playback", () => {
    expect(
      stallThresholdMs({
        baseThresholdMs: BASE,
        postSeekThresholdMs: POST_SEEK,
        postSeekGraceMs: GRACE,
        sinceSeekMs: GRACE,
      })
    ).toBe(BASE);
  });

  it("extends the window right after a seek", () => {
    expect(
      stallThresholdMs({
        baseThresholdMs: BASE,
        postSeekThresholdMs: POST_SEEK,
        postSeekGraceMs: GRACE,
        sinceSeekMs: 2_000,
      })
    ).toBe(POST_SEEK);
  });

  it("never shortens an engine threshold that is already longer", () => {
    // The transcode path runs a much longer window; a seek must not reduce it.
    expect(
      stallThresholdMs({
        baseThresholdMs: 52_000,
        postSeekThresholdMs: POST_SEEK,
        postSeekGraceMs: GRACE,
        sinceSeekMs: 1_000,
      })
    ).toBe(52_000);
  });
});
