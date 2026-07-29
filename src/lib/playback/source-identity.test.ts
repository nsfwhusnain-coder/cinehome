/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { PlaybackSource } from "./types";
import { dedupePlaybackSources } from "./source-identity";

function debridSource(slot: 1 | 2 | 3): PlaybackSource {
  return {
    id: `realdebrid-tt123-movie-0-0-native-1080-${slot}`,
    url: `https://cdn.example/release-${slot}.mp4`,
    provider: "Debrid",
    quality: "1080p",
    label: "1080p • Debrid",
    type: "mp4",
    maxHeight: 1080,
    origin: "debrid",
    compat: "native",
    codec: "h264",
    container: "mp4",
  };
}

describe("dedupePlaybackSources", () => {
  it("preserves distinct Real-Debrid native 1080 backup slots", () => {
    const sources = [
      debridSource(1),
      debridSource(2),
      debridSource(3),
    ];

    expect(dedupePlaybackSources(sources).map((source) => source.id)).toEqual(
      sources.map((source) => source.id)
    );
  });

  it("still collapses duplicate representations of an ordinary embed server", () => {
    const shared: Omit<PlaybackSource, "id" | "url"> = {
      provider: "Vixsrc",
      quality: "1080p",
      label: "Luna",
      type: "hls",
      maxHeight: 1080,
    };
    const sources: PlaybackSource[] = [
      { ...shared, id: "luna-direct", url: "https://cdn.example/direct.m3u8" },
      { ...shared, id: "luna-proxy", url: "https://cdn.example/proxy.m3u8" },
    ];

    expect(dedupePlaybackSources(sources)).toHaveLength(1);
  });
});
