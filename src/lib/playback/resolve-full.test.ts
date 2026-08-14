/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  clearRosterCache,
  rosterCacheKey,
  ROSTER_CACHE_TTL_MS,
} from "./resolve-full";

afterEach(() => {
  clearRosterCache();
});

describe("rosterCacheKey", () => {
  it("is stable for the same title and user", () => {
    const args = {
      userId: "u1",
      type: "movie" as const,
      tmdbId: 550,
    };
    expect(rosterCacheKey(args)).toBe(rosterCacheKey(args));
  });

  it("changes when season or episode changes", () => {
    const base = { userId: "u1", type: "tv" as const, tmdbId: 61838 };
    expect(rosterCacheKey({ ...base, season: 1, episode: 1 })).not.toBe(
      rosterCacheKey({ ...base, season: 1, episode: 2 })
    );
  });
});

describe("ROSTER_CACHE_TTL_MS", () => {
  it("is long enough to cover a skip without going stale mid-title", () => {
    expect(ROSTER_CACHE_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(ROSTER_CACHE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
