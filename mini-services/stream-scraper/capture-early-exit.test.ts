/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  EARLY_EXIT_MIN_HLS,
  EARLY_EXIT_SETTLE_MS,
  EARLY_EXIT_TARGET_CAPTURES,
  countGoodEarlyCaptures,
  isGoodEarlyCapture,
  isHlsEarlyCapture,
  shouldEarlyExitWait,
  type EarlyExitCapture,
} from "./capture-early-exit";

const HLS = "https://cdn.example.com/hls/master.m3u8";
const HLS2 = "https://cdn.example.com/hls/720p/index.m3u8";
const HLS3 = "https://cdn.example.com/hls/480p/index.m3u8";
const MP4 = "https://cdn.example.com/videos/file.mp4";
const POISON = "https://cloudflare-terms-of-service-abuse.com/stream.mp4";
const POISON_HLS = "https://foo.hostingersite.com/master.m3u8";

describe("isGoodEarlyCapture / isHlsEarlyCapture", () => {
  it("accepts m3u8 and HLS label", () => {
    expect(isGoodEarlyCapture(HLS)).toBe(true);
    expect(isGoodEarlyCapture(HLS, "HLS")).toBe(true);
    expect(isHlsEarlyCapture(HLS, "HLS")).toBe(true);
  });

  it("accepts non-poison mp4", () => {
    expect(isGoodEarlyCapture(MP4, "MP4")).toBe(true);
    expect(isHlsEarlyCapture(MP4, "MP4")).toBe(false);
  });

  it("rejects poison urls", () => {
    expect(isGoodEarlyCapture(POISON, "MP4")).toBe(false);
    expect(isGoodEarlyCapture(POISON_HLS, "HLS")).toBe(false);
  });

  it("rejects trailer / sample / preview captures", () => {
    expect(
      isGoodEarlyCapture("https://cdn.example.com/hls/trailer/master.m3u8", "HLS")
    ).toBe(false);
    expect(
      isGoodEarlyCapture("https://cdn.example.com/videos/file.mp4", "Official Trailer")
    ).toBe(false);
    expect(
      isGoodEarlyCapture("https://cdn.example.com/videos/sample.mp4", "MP4")
    ).toBe(false);
  });

  it("rejects empty / non-stream paths", () => {
    expect(isGoodEarlyCapture("")).toBe(false);
    expect(isGoodEarlyCapture("https://cdn.example.com/ad.js")).toBe(false);
  });
});

describe("countGoodEarlyCaptures", () => {
  it("counts only non-poison good streams", () => {
    const captures: EarlyExitCapture[] = [
      { url: HLS, label: "HLS" },
      { url: POISON, label: "MP4" },
      { url: MP4, label: "MP4" },
    ];
    expect(countGoodEarlyCaptures(captures)).toBe(2);
  });
});

describe("shouldEarlyExitWait", () => {
  const hard = 100_000;

  it("no captures → false", () => {
    expect(
      shouldEarlyExitWait({
        captures: [],
        firstGoodAtMs: null,
        nowMs: 1_000,
        hardDeadlineMs: hard,
      })
    ).toBe(false);
  });

  it("1 m3u8 immediately (settle 0) → false until settle elapsed", () => {
    const t0 = 10_000;
    expect(
      shouldEarlyExitWait({
        captures: [{ url: HLS, label: "HLS" }],
        firstGoodAtMs: t0,
        nowMs: t0,
        hardDeadlineMs: hard,
      })
    ).toBe(false);
    expect(
      shouldEarlyExitWait({
        captures: [{ url: HLS, label: "HLS" }],
        firstGoodAtMs: t0,
        nowMs: t0 + EARLY_EXIT_SETTLE_MS - 1,
        hardDeadlineMs: hard,
      })
    ).toBe(false);
  });

  it("1 m3u8 + settle elapsed → true", () => {
    const t0 = 10_000;
    expect(
      shouldEarlyExitWait({
        captures: [{ url: HLS, label: "HLS" }],
        firstGoodAtMs: t0,
        nowMs: t0 + EARLY_EXIT_SETTLE_MS,
        hardDeadlineMs: hard,
      })
    ).toBe(true);
    expect(EARLY_EXIT_MIN_HLS).toBe(1);
  });

  it("3 good captures → true even before settle", () => {
    const t0 = 10_000;
    expect(
      shouldEarlyExitWait({
        captures: [
          { url: HLS, label: "HLS" },
          { url: HLS2, label: "HLS" },
          { url: HLS3, label: "HLS" },
        ],
        firstGoodAtMs: t0,
        nowMs: t0 + 50,
        hardDeadlineMs: hard,
      })
    ).toBe(true);
    expect(EARLY_EXIT_TARGET_CAPTURES).toBe(3);
  });

  it("poison-only → false", () => {
    expect(
      shouldEarlyExitWait({
        captures: [
          { url: POISON, label: "MP4" },
          { url: POISON_HLS, label: "HLS" },
        ],
        firstGoodAtMs: 10_000,
        nowMs: 10_000 + EARLY_EXIT_SETTLE_MS + 5_000,
        hardDeadlineMs: hard,
      })
    ).toBe(false);
  });

  it("past hard deadline → true", () => {
    expect(
      shouldEarlyExitWait({
        captures: [],
        firstGoodAtMs: null,
        nowMs: hard,
        hardDeadlineMs: hard,
      })
    ).toBe(true);
    expect(
      shouldEarlyExitWait({
        captures: [],
        firstGoodAtMs: null,
        nowMs: hard + 1,
        hardDeadlineMs: hard,
      })
    ).toBe(true);
  });

  it("1 solid mp4 after settle → true", () => {
    const t0 = 5_000;
    expect(
      shouldEarlyExitWait({
        captures: [{ url: MP4, label: "MP4" }],
        firstGoodAtMs: t0,
        nowMs: t0 + EARLY_EXIT_SETTLE_MS,
        hardDeadlineMs: hard,
      })
    ).toBe(true);
  });

  it("1 mp4 before settle → false", () => {
    const t0 = 5_000;
    expect(
      shouldEarlyExitWait({
        captures: [{ url: MP4, label: "MP4" }],
        firstGoodAtMs: t0,
        nowMs: t0 + 100,
        hardDeadlineMs: hard,
      })
    ).toBe(false);
  });
});
