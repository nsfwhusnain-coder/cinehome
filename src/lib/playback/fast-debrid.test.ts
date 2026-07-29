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

  it("honors a fixed quality only when that exact rung is cached", () => {
    const sources = [
      debrid({ id: "native-2160", quality: "2160p", maxHeight: 2160 }),
      debrid({ id: "native-1080", quality: "1080p", maxHeight: 1080 }),
      debrid({ id: "native-720", quality: "720p", maxHeight: 720 }),
    ];

    expect(buildFastDebridResponse(sources, 1080)?.sources.map((source) => source.id))
      .toEqual(["native-1080"]);
    expect(buildFastDebridResponse(sources, 720)?.sources.map((source) => source.id))
      .toEqual(["native-720"]);
    expect(buildFastDebridResponse(sources, 320)).toBeNull();
  });
});
