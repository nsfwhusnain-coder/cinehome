import { describe, expect, it } from "bun:test";
import type { PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import { mergePlaybackResponses } from "./use-playback";

function source(url: string): PlaybackSource {
  return {
    id: "debrid-slot",
    url,
    provider: "Real-Debrid",
    quality: "1080p",
    label: "1080p",
    type: "mp4",
  };
}

describe("watch playback recovery merge", () => {
  it("does not resurrect a stale fast URL when recovery is temporarily empty", () => {
    const fast: PlaybackResponse = {
      status: "available",
      sources: [source("https://old.invalid/video.mp4")],
    };
    const recovery: PlaybackResponse = {
      status: "error",
      sources: [],
      partial: true,
      refreshNonce: 123,
    };

    const merged = mergePlaybackResponses(fast, recovery, false);

    expect(merged?.sources).toEqual([]);
    expect(merged?.streamUrl).toBeUndefined();
    expect(merged?.refreshNonce).toBe(123);
    expect(merged?.partial).toBe(true);
  });

  it("uses only the refreshed URL when recovery returns the same stable id", () => {
    const fast: PlaybackResponse = {
      status: "available",
      sources: [source("https://old.invalid/video.mp4")],
    };
    const recovery: PlaybackResponse = {
      status: "available",
      sources: [source("https://fresh.invalid/video.mp4")],
      streamUrl: "https://fresh.invalid/video.mp4",
      refreshNonce: 456,
    };

    const merged = mergePlaybackResponses(fast, recovery, false);

    expect(merged?.sources?.map((item) => item.url)).toEqual([
      "https://fresh.invalid/video.mp4",
    ]);
    expect(merged?.streamUrl).toBe("https://fresh.invalid/video.mp4");
  });
});
