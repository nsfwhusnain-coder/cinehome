/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { assessMediaDuration, hlsMediaDurationSeconds } from "./media-duration";

describe("assessMediaDuration", () => {
  it("rejects a two-minute clip for a feature film", () => {
    const result = assessMediaDuration(130, 120 * 60, "movie");
    expect(result.plausible).toBe(false);
  });

  it("rejects a two-minute clip for a normal TV episode", () => {
    const result = assessMediaDuration(130, 24 * 60, "tv");
    expect(result.plausible).toBe(false);
  });

  it("allows ordinary cut and episode-runtime variation", () => {
    expect(assessMediaDuration(82 * 60, 100 * 60, "movie").plausible).toBe(true);
    expect(assessMediaDuration(11 * 60, 24 * 60, "tv").plausible).toBe(true);
  });

  it("does not guess when the expected runtime is unknown or short-form", () => {
    expect(assessMediaDuration(130, 0, "movie").plausible).toBe(true);
    expect(assessMediaDuration(130, 8 * 60, "movie").plausible).toBe(true);
  });
});

describe("hlsMediaDurationSeconds", () => {
  it("sums decimal EXTINF durations and ignores malformed tags", () => {
    const manifest = [
      "#EXTM3U",
      "#EXTINF:6.006,",
      "seg-1.ts",
      "#EXTINF:not-a-number,",
      "bad.ts",
      "#EXTINF:4,Episode",
      "seg-2.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(hlsMediaDurationSeconds(manifest)).toBeCloseTo(10.006, 3);
  });

  it("returns zero for a master playlist", () => {
    expect(
      hlsMediaDurationSeconds(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n"
      )
    ).toBe(0);
  });
});
