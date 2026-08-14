/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import type { PlaybackSource } from "./types";
import {
  SOURCE_URL_CACHE_TTL_MS,
  clearPlaybackSourceUrlCache,
  lookupPlaybackSourceUrl,
  playbackSourceCacheKey,
  rememberPlaybackRoster,
  rememberPlaybackSource,
} from "./source-url-cache";

afterEach(() => {
  clearPlaybackSourceUrlCache();
});

const identity = {
  userId: "user-1",
  mediaType: "movie" as const,
  tmdbId: 550,
};

function source(
  overrides: Partial<PlaybackSource> = {}
): Pick<PlaybackSource, "id" | "url" | "container" | "codec"> {
  return {
    id: overrides.id ?? "hades-4k",
    url: overrides.url ?? "https://cdn.example/movie.mkv",
    container: overrides.container ?? "mkv",
    codec: overrides.codec ?? "h264",
  };
}

describe("playbackSourceCacheKey", () => {
  it("is scoped to user, title, episode, and source — never a debrid token", () => {
    const key = playbackSourceCacheKey({
      ...identity,
      sourceId: "hades-4k",
    });
    expect(key).toBe("user-1:movie:550:::hades-4k");
    expect(key).not.toMatch(/realdebrid|token|bearer/i);
  });

  it("keeps season 0 / episode 0 distinct from omitted specials", () => {
    const specials = playbackSourceCacheKey({
      userId: "user-1",
      mediaType: "tv",
      tmdbId: 1399,
      season: 0,
      episode: 0,
      sourceId: "src",
    });
    const omitted = playbackSourceCacheKey({
      userId: "user-1",
      mediaType: "tv",
      tmdbId: 1399,
      sourceId: "src",
    });
    expect(specials).toBe("user-1:tv:1399:0:0:src");
    expect(specials).not.toBe(omitted);
  });
});

describe("rememberPlaybackSource / lookupPlaybackSourceUrl", () => {
  it("returns the remembered URL and optional container/codec", () => {
    rememberPlaybackSource({
      ...identity,
      source: source(),
    });
    expect(
      lookupPlaybackSourceUrl({ ...identity, sourceId: "hades-4k" })
    ).toEqual({
      url: "https://cdn.example/movie.mkv",
      container: "mkv",
      codec: "h264",
    });
  });

  it("does not leak a URL across users or titles", () => {
    rememberPlaybackSource({
      ...identity,
      source: source(),
    });
    expect(
      lookupPlaybackSourceUrl({
        ...identity,
        userId: "user-2",
        sourceId: "hades-4k",
      })
    ).toBeNull();
    expect(
      lookupPlaybackSourceUrl({
        ...identity,
        tmdbId: 551,
        sourceId: "hades-4k",
      })
    ).toBeNull();
  });

  it("expires after the remux TTL", () => {
    rememberPlaybackSource({
      ...identity,
      source: source(),
    });
    expect(
      lookupPlaybackSourceUrl(
        { ...identity, sourceId: "hades-4k" },
        Date.now() + SOURCE_URL_CACHE_TTL_MS + 1
      )
    ).toBeNull();
  });

  it("remembers every source in a returned roster", () => {
    rememberPlaybackRoster(identity, [
      source({ id: "a", url: "https://cdn.example/a.mp4", container: "mp4" }),
      source({ id: "b", url: "https://cdn.example/b.mkv" }),
    ] as PlaybackSource[]);
    expect(lookupPlaybackSourceUrl({ ...identity, sourceId: "a" })?.url).toBe(
      "https://cdn.example/a.mp4"
    );
    expect(lookupPlaybackSourceUrl({ ...identity, sourceId: "b" })?.url).toBe(
      "https://cdn.example/b.mkv"
    );
  });

  it("remembers quality rungs under sourceId::height", () => {
    rememberPlaybackRoster(identity, [
      {
        id: "quasar",
        url: "https://cdn.example/1080.mp4",
        provider: "Videasy",
        label: "Quasar",
        quality: "1080p",
        type: "mp4",
        qualityRungs: [
          { height: 1080, url: "https://cdn.example/1080.mp4" },
          { height: 720, url: "https://cdn.example/720.mp4" },
        ],
      },
    ]);
    expect(
      lookupPlaybackSourceUrl({ ...identity, sourceId: "quasar::720" })?.url
    ).toBe("https://cdn.example/720.mp4");
  });
});
