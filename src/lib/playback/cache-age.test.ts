import { describe, expect, it } from "bun:test";
import { usableCachedPlayback } from "./cache-age";
import type { PlaybackResponse } from "./types";

const complete: PlaybackResponse = {
  status: "available",
  streamUrl: "/api/hls/complete",
  sources: [],
};
const partial: PlaybackResponse = { ...complete, partial: true };

describe("usableCachedPlayback", () => {
  it("keeps complete data for less than the signed-source client window", () => {
    expect(usableCachedPlayback(complete, 1_000, 120_999)).toBe(complete);
    expect(usableCachedPlayback(complete, 1_000, 121_001)).toBeUndefined();
  });

  it("keeps playable partial data while forcing a background refresh", () => {
    expect(usableCachedPlayback(partial, 1_000, 120_999)).toBe(partial);
    expect(usableCachedPlayback(partial, 1_000, 121_001)).toBeUndefined();
  });

  it("rejects unknown or future cache timestamps", () => {
    expect(usableCachedPlayback(complete, 0, 10_000)).toBeUndefined();
    expect(usableCachedPlayback(complete, 11_000, 10_000)).toBeUndefined();
  });
});
