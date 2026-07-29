import { describe, expect, it } from "bun:test";
import {
  buildPlayerQualityOptions,
  normalizePlayerQualityHeight,
  selectSourceForQuality,
  shouldCommitQualityTarget,
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
    expect(normalizePlayerQualityHeight(360)).toBe(360);
    expect(normalizePlayerQualityHeight(320)).toBe(320);
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
      "320p",
    ]);
    expect(options.find((option) => option.value === 1080)?.levelIndex).toBe(2);
    expect(options.find((option) => option.value === 2160)?.sourceId).toBe("uhd");
    expect(options.find((option) => option.value === 360)?.status).toBe("unavailable");
    expect(options.find((option) => option.value === 320)?.status).toBe("unavailable");
  });

  it("maps a real cropped 1440p adaptive rendition to the 1440p rail", () => {
    const options = buildPlayerQualityOptions({
      sources: [source("adaptive", 2160, [2160, 1440, 1080])],
      activeSourceId: "adaptive",
      activeLevels: [
        { index: 0, width: 1920, height: 800, bitrate: 4_000_000 },
        { index: 1, width: 2560, height: 1072, bitrate: 7_000_000 },
        { index: 2, width: 3840, height: 1600, bitrate: 15_000_000 },
      ],
      selected: "auto",
    });

    const qhd = options.find((option) => option.value === 1440);
    expect(qhd?.status).toBe("available");
    expect(qhd?.levelIndex).toBe(1);
  });

  it("removes failed and probe-dead sources from quality routing", () => {
    const dead = source("dead", 2160);
    dead.probe = { ok: false, ttfbMs: 0, bytesPerSec: 0, speedScore: 0 };
    const alive = source("alive", 1080);
    expect(selectSourceForQuality([dead, alive], 2160)).toBeNull();
    expect(selectSourceForQuality([source("failed", 2160)], 2160, new Set(["failed"]))).toBeNull();
  });

  it("shows a stored unavailable preference separately from the effective fallback", () => {
    const options = buildPlayerQualityOptions({
      sources: [source("hd", 720)],
      activeSourceId: "hd",
      activeLevels: [{ index: 0, height: 720 }],
      selected: 2160,
      actualHeight: 720,
    });
    const preferred = options.find((option) => option.value === 2160)!;
    const effective = options.find((option) => option.value === 720)!;

    expect(preferred.status).toBe("unavailable");
    expect(preferred.preferred).toBe(true);
    expect(effective.status).toBe("active");
    expect(shouldCommitQualityTarget(preferred)).toBe(false);
    expect(shouldCommitQualityTarget(preferred, true)).toBe(true);
  });

  it("labels a decoder-confirmed fallback when metadata promised the preferred rung", () => {
    const options = buildPlayerQualityOptions({
      sources: [source("flaky-adaptive", 720, [720, 480])],
      activeSourceId: "flaky-adaptive",
      activeLevels: [
        { index: 0, height: 480 },
        { index: 1, height: 720 },
      ],
      selected: 720,
      actualHeight: 480,
    });

    const preferred = options.find((option) => option.value === 720)!;
    const effective = options.find((option) => option.value === 480)!;
    expect(preferred.preferred).toBe(true);
    expect(preferred.fallbackHeight).toBe(480);
    expect(preferred.status).toBe("available");
    expect(effective.status).toBe("active");
  });
});
