/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  normalizeQualityHeight,
  parseContentClassParam,
  resultCacheKey,
} from "./result-cache-key";

describe("scraper result cache quality identity", () => {
  it("separates 1080 and 2160 ranked inventories", () => {
    const hd = resultCacheKey(550, "movie", undefined, undefined, 1080, false);
    const uhd = resultCacheKey(550, "movie", undefined, undefined, 2160, false);

    expect(hd).not.toBe(uhd);
  });

  it("separates fast partial and full-pass inventories", () => {
    const fast = resultCacheKey(550, "movie", undefined, undefined, 2160, true);
    const full = resultCacheKey(550, "movie", undefined, undefined, 2160, false);

    expect(fast).not.toBe(full);
    expect(fast).toEndWith(":fast");
    expect(full).toEndWith(":full");
  });

  it("normalizes invalid and oversized quality hints", () => {
    expect(normalizeQualityHeight(Number.NaN)).toBe(1080);
    expect(normalizeQualityHeight(9999)).toBe(4320);
  });

  it("separates anime ranking inventory from the default key", () => {
    const base = resultCacheKey(1396, "tv", 1, 1, 2160, false);
    const anime = resultCacheKey(1396, "tv", 1, 1, 2160, false, "anime");
    expect(anime).not.toBe(base);
    expect(anime).toContain(":anime:");
    expect(base).not.toContain(":anime:");
  });

  it("parses contentClass=anime or TV anime=1 query flag", () => {
    expect(parseContentClassParam("anime", null, "movie")).toBe("anime");
    expect(parseContentClassParam(null, "1", "tv")).toBe("anime");
    expect(parseContentClassParam(null, "1", "movie")).toBeUndefined();
    expect(parseContentClassParam(null, null, "tv")).toBeUndefined();
  });
});
