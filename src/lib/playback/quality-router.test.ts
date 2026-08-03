import { describe, expect, it } from "bun:test";
import {
  buildPlayerQualityOptions,
  normalizePlayerQualityHeight,
  selectSourceForQuality,
} from "./quality-router";
import type { PlaybackSource } from "./types";

function source(
  id: string,
  maxHeight: number,
  ladder?: number[]
): PlaybackSource {
  return {
    id,
    url: `https://example.test/${id}.m3u8`,
    provider: id,
    label: id,
    quality: `${maxHeight}p`,
    type: "hls",
    maxHeight,
    ladder,
    verified: true,
    probe: { ok: true, ttfbMs: 100, bytesPerSec: 1_000_000, speedScore: 90 },
  };
}

describe("quality router", () => {
  it("normalizes conventional and cropped delivery heights honestly", () => {
    expect(normalizePlayerQualityHeight(2160)).toBe(2160);
    expect(normalizePlayerQualityHeight(1080)).toBe(1080);
    expect(normalizePlayerQualityHeight(800)).toBe(720);
    expect(normalizePlayerQualityHeight(1440)).toBe(1440);
  });

  it("keeps the same stable rail and marks real availability", () => {
    const options = buildPlayerQualityOptions({
      sources: [source("adaptive", 1080, [1080, 720, 480]), source("uhd", 2160)],
      activeSourceId: "adaptive",
      activeLevels: [
        { index: 0, height: 480 },
        { index: 1, height: 720 },
        { index: 2, height: 1080 },
      ],
      selected: "auto",
    });
    expect(options.map((option) => option.label)).toEqual([
      "Auto",
      "4K",
      "1440p",
      "1080p",
      "720p",
      "480p",
      "360p",
    ]);
    expect(options.find((option) => option.value === 1080)?.levelIndex).toBe(2);
    expect(options.find((option) => option.value === 2160)?.sourceId).toBe("uhd");
    expect(options.find((option) => option.value === 360)?.status).toBe("unavailable");
  });

  it("removes failed and probe-dead sources from quality routing", () => {
    const dead = source("dead", 2160);
    dead.probe = { ok: false, ttfbMs: 0, bytesPerSec: 0, speedScore: 0 };
    const alive = source("alive", 1080);
    expect(selectSourceForQuality([dead, alive], 2160)).toBeNull();
    expect(selectSourceForQuality([source("failed", 2160)], 2160, new Set(["failed"]))).toBeNull();
  });

  it("keeps discovered 4K visible when this browser cannot decode its codec", () => {
    const hevc4k = source("hevc-4k", 2160);
    hevc4k.codec = "hevc";
    hevc4k.compat = "safari";

    const option = buildPlayerQualityOptions({
      sources: [hevc4k, source("hd", 1080)],
      activeLevels: [],
      selected: "auto",
    }).find((candidate) => candidate.value === 2160);

    expect(option?.status).toBe("device-unsupported");
    expect(option?.unavailableReason).toContain("HEVC");
    expect(option?.sourceId).toBeUndefined();
  });
});
