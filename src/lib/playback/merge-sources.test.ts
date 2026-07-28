/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { mergeProgressivePlaybackSources } from "./merge-sources";
import type { PlaybackSource } from "./types";

function source(url: string, maxHeight: number): PlaybackSource {
  return {
    id: "stable-server",
    url,
    provider: "CinemaOS",
    label: "Cinema PT 1080",
    quality: "1080p",
    type: "mp4",
    maxHeight,
  };
}

describe("mergeProgressivePlaybackSources", () => {
  it("keeps an active fast-path URL during ordinary enrichment", () => {
    const [merged] = mergeProgressivePlaybackSources(
      [source("https://old.example/video", 720)],
      [source("https://fresh.example/video", 1080)]
    );
    expect(merged?.url).toBe("https://old.example/video");
    expect(merged?.maxHeight).toBe(1080);
  });

  it("replaces the dead URL when the full response is a recovery refresh", () => {
    const [merged] = mergeProgressivePlaybackSources(
      [source("https://old.example/video", 720)],
      [source("https://fresh.example/video", 1080)],
      true
    );
    expect(merged?.url).toBe("https://fresh.example/video");
    expect(merged?.maxHeight).toBe(1080);
  });
});
