/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { detectCodec, toPlaybackSource } from "./scraper";

const session = {
  referer: "https://licensed.example/",
  origin: "https://licensed.example",
  userAgent: "test",
  cookies: "",
};

describe("scraper source 4K inventory", () => {
  it("detects AV1 and HEVC without deleting capable-device inventory", () => {
    expect(detectCodec("https://media.example/movie.av01.mp4")).toBe("av1");
    expect(detectCodec("https://media.example/movie.hevc.mp4")).toBe("hevc");

    const av1 = toPlaybackSource(
      {
        url: "https://media.example/movie.av01.mp4",
        quality: "2160p",
        label: "File",
        provider: "Licensed CDN",
        session,
        type: "mp4",
        maxHeight: 2160,
        qualitySource: "probe",
      },
      "/api/hls/session-av1"
    );

    expect(av1.codec).toBe("av1");
    expect(av1.maxHeight).toBe(2160);
  });

  it("uses the upstream URL to distinguish same-labelled fixed rungs", () => {
    const common = {
      quality: "auto",
      label: "HLS",
      provider: "Licensed CDN",
      session,
      type: "hls" as const,
    };
    const hd = toPlaybackSource(
      { ...common, url: "https://media.example/1080.m3u8", maxHeight: 1080 },
      "/api/hls/hd"
    );
    const uhd = toPlaybackSource(
      { ...common, url: "https://media.example/2160.m3u8", maxHeight: 2160 },
      "/api/hls/uhd"
    );

    expect(hd.id).not.toBe(uhd.id);
  });
});
