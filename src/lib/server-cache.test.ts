/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  PLAYBACK_PARTIAL_TTL_MS,
  PLAYBACK_PARTIAL_WITH_SOURCES_TTL_MS,
  PLAYBACK_TTL_MS,
  playbackCacheKey,
  playbackResponseTtlMs,
  rawScrapeCacheKey,
} from "./server-cache";

describe("raw scraper cache quality identity", () => {
  it("separates 1080 and 4K rosters after quality-dependent ranking", () => {
    const hd = rawScrapeCacheKey("movie", 550, undefined, undefined, false, 1080);
    const uhd = rawScrapeCacheKey("movie", 550, undefined, undefined, false, 2160);

    expect(hd).not.toBe(uhd);
  });

  it("normalizes auto to the 1080 discovery bucket", () => {
    const auto = rawScrapeCacheKey("tv", 1, 1, 2, true, "auto");
    const hd = rawScrapeCacheKey("tv", 1, 1, 2, true, 1080);

    expect(auto).toBe(hd);
  });

  it("partitions anime ranking away from the default class", () => {
    const base = rawScrapeCacheKey("tv", 1429, 1, 1, false, 2160);
    const anime = rawScrapeCacheKey("tv", 1429, 1, 1, false, 2160, "anime");
    expect(anime).not.toBe(base);
    expect(anime.endsWith(":anime")).toBe(true);
  });
});

describe("playback response TTL", () => {
  it("keeps empty partials short so a soft-miss hunt can advance", () => {
    expect(playbackResponseTtlMs({ partial: true, sources: [] })).toBe(
      PLAYBACK_PARTIAL_TTL_MS
    );
  });

  it("does not expire a playable partial every 1.5s", () => {
    expect(
      playbackResponseTtlMs({
        partial: true,
        sources: [{ id: "a" }],
      })
    ).toBe(PLAYBACK_PARTIAL_WITH_SOURCES_TTL_MS);
    expect(
      playbackResponseTtlMs({
        partial: true,
        sources: [],
        streamUrl: "https://example/master.m3u8",
      })
    ).toBe(PLAYBACK_PARTIAL_WITH_SOURCES_TTL_MS);
  });

  it("uses the full TTL once the roster is complete", () => {
    expect(playbackResponseTtlMs({ sources: [{ id: "a" }] })).toBe(PLAYBACK_TTL_MS);
  });
});

describe("playback cache key", () => {
  it("includes anime class so default streamUrl cannot leak across titles", () => {
    const base = playbackCacheKey("tv", 1429, 1, 1, false, "user-a", 2160);
    const anime = playbackCacheKey("tv", 1429, 1, 1, false, "user-a", 2160, "anime");
    expect(anime).not.toBe(base);
  });
});
