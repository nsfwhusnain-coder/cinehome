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
});
