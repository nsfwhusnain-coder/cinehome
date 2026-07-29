/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { buildFastDebridResponse } from "./fast-debrid";
import type { PlaybackSource } from "./types";

function debrid(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "native-1080",
    url: "https://download.real-debrid.example/movie.mp4",
    provider: "Debrid",
    label: "1080p • Debrid",
    quality: "1080p",
    type: "mp4",
    maxHeight: 1080,
    origin: "debrid",
    codec: "h264",
    container: "mp4",
    compat: "native",
    ...overrides,
  };
}

describe("buildFastDebridResponse", () => {
  it("returns an immediately playable partial response from a native cache hit", () => {
    const response = buildFastDebridResponse([debrid()]);
    expect(response).toEqual({
      status: "available",
      streamUrl: "https://download.real-debrid.example/movie.mp4",
      sources: [debrid()],
      providerId: "debrid",
      partial: true,
    });
  });

  it("returns null when the cache contains only browser-incompatible media", () => {
    const response = buildFastDebridResponse([
      debrid({
        id: "mkv",
        url: "https://download.real-debrid.example/movie.mkv",
        container: "mkv",
      }),
    ]);
    expect(response).toBeNull();
  });

  it("honors an exact fixed quality without hiding trusted backup servers", () => {
    const sources = [
      debrid({
        id: "native-2160",
        url: "https://download.real-debrid.example/movie-2160.mp4",
        quality: "2160p",
        maxHeight: 2160,
      }),
      debrid({
        id: "native-1080",
        url: "https://download.real-debrid.example/movie-1080.mp4",
        quality: "1080p",
        maxHeight: 1080,
      }),
      debrid({
        id: "native-720",
        url: "https://download.real-debrid.example/movie-720.mp4",
        quality: "720p",
        maxHeight: 720,
      }),
    ];

    const fixed1080 = buildFastDebridResponse(sources, 1080);
    expect(fixed1080?.streamUrl).toBe(sources[1]!.url);
    expect(fixed1080?.sources?.map((source) => source.id)).toEqual([
      "native-2160",
      "native-1080",
      "native-720",
    ]);
  });

  it("falls back truthfully when the saved rung is unavailable", () => {
    const sources = [
      debrid({ id: "native-1080-a" }),
      debrid({
        id: "native-1080-b",
        url: "https://download.real-debrid.example/movie-backup.mp4",
      }),
    ];

    const response = buildFastDebridResponse(sources, 720);
    expect(response?.status).toBe("available");
    expect(response?.streamUrl).toBe(sources[0]!.url);
    expect(response?.sources).toEqual(sources);
  });
});
