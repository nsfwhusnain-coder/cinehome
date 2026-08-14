/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { tvQueryIndex } from "./tv-index";

describe("tvQueryIndex", () => {
  it("keeps season/episode 0 instead of coercing to 1", () => {
    expect(tvQueryIndex(0)).toBe(0);
    expect(tvQueryIndex(2)).toBe(2);
    expect(tvQueryIndex(undefined)).toBe(1);
    expect(tvQueryIndex(null)).toBe(1);
    expect(tvQueryIndex(Number.NaN)).toBe(1);
    expect(tvQueryIndex(-1)).toBe(1);
  });
});
