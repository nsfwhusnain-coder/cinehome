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

  it("still answers from an MKV-only cache hit — the container is remuxed, not rejected", () => {
    const mkv = debrid({
      id: "mkv",
      url: "https://download.real-debrid.example/movie.mkv",
      container: "mkv",
    });
    const response = buildFastDebridResponse([mkv]);
    // `streamUrl` stays the raw source URL: it is the fast path's hint, and the
    // player derives the real /api/transcode?mode=remux URL from the source it
    // selects (see sourceDelivery in video-player.tsx). What matters here is
    // that an MKV-only hit is no longer discarded as unplayable.
    expect(response?.status).toBe("available");
    expect(response?.sources).toEqual([mkv]);
  });

  it("returns null when the cache holds only media this browser cannot decode", () => {
    const response = buildFastDebridResponse([
      debrid({
        id: "hevc",
        url: "https://download.real-debrid.example/movie.mkv",
        container: "mkv",
        codec: "hevc",
      }),
    ]);
    expect(response).toBeNull();
  });
});
