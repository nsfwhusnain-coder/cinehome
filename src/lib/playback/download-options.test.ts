/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  buildDownloadOptions,
  downloadDetailLine,
  downloadFilename,
  downloadSizeLabel,
  estimateSizeBytes,
  formatFileSize,
} from "./download-options";
import type { PlaybackSource } from "./types";

function src(overrides: Partial<PlaybackSource> & { id: string }): PlaybackSource {
  return {
    url: `https://cdn.example/${overrides.id}.mp4`,
    provider: "Debrid",
    label: overrides.label ?? "Kronos",
    quality: "1080p",
    type: "mp4",
    origin: "debrid",
    codec: "h264",
    container: "mp4",
    audioLanguage: "en",
    ...overrides,
  };
}

describe("formatFileSize", () => {
  it("uses GB and MB honestly", () => {
    expect(formatFileSize(2.5 * 1024 ** 3)).toBe("2.50 GB");
    expect(formatFileSize(640 * 1024 ** 2)).toBe("640 MB");
    expect(formatFileSize(0)).toBeNull();
  });
});

describe("buildDownloadOptions", () => {
  it("lists each quality with size and keeps debrid over embed", () => {
    const kronos = src({
      id: "kronos",
      maxHeight: 1080,
      sizeBytes: 4 * 1024 ** 3,
    });
    const cinema = src({
      id: "cinema",
      provider: "CinemaOS",
      origin: "embed",
      label: "Cinema",
      maxHeight: 1080,
      sizeBytes: 2 * 1024 ** 3,
    });
    const hades = src({
      id: "hades",
      label: "Hades",
      maxHeight: 2160,
      container: "mkv",
      codec: "h264",
      sizeBytes: 18 * 1024 ** 3,
    });
    const luna = src({
      id: "luna",
      provider: "Vixsrc",
      origin: "embed",
      type: "hls",
      url: "https://cdn.example/luna.m3u8",
      maxHeight: 1080,
    });
    const options = buildDownloadOptions([luna, cinema, kronos, hades]);
    expect(options.map((option) => option.height)).toEqual([2160, 1080]);
    const hd = options.find((option) => option.height === 1080);
    expect(hd?.sourceId).toBe("kronos");
    expect(downloadSizeLabel(hd!)).toBe("4.00 GB");
    expect(downloadDetailLine(hd!)).toContain("MP4");
    expect(options[0]?.downloadable).toBe(true);
    expect(options.find((option) => option.sourceId === "luna")).toBeUndefined();
  });

  it("exposes rungs as separate qualities", () => {
    const quasar = src({
      id: "quasar",
      origin: "embed",
      provider: "Videasy",
      label: "Quasar",
      qualityRungs: [
        { height: 1080, url: "https://cdn.example/1080.mp4", bitrateBps: 8_000_000 },
        { height: 720, url: "https://cdn.example/720.mp4", bitrateBps: 3_000_000 },
      ],
    });
    const options = buildDownloadOptions([quasar], 2 * 3600);
    expect(options.map((option) => option.label)).toEqual(["1080p", "720p"]);
    expect(options[0]?.estimatedSizeBytes).toBe(estimateSizeBytes(8_000_000, 7200));
    expect(downloadFilename("Fight Club", options[0]!)).toBe("Fight Club 1080p.mp4");
  });
});
