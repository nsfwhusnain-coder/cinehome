/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  FEATURE_MOVIE_MIN_EXPECTED_S,
  MOVIE_CLIP_MAX_S,
  isImplausibleEmbedDuration,
} from "./embed-duration";

describe("isImplausibleEmbedDuration", () => {
  it("rejects a 3–15 min clip for a feature film (≥80 min)", () => {
    const expected = FEATURE_MOVIE_MIN_EXPECTED_S;
    expect(isImplausibleEmbedDuration(3 * 60, expected, "movie")).toBe(true);
    expect(isImplausibleEmbedDuration(MOVIE_CLIP_MAX_S, expected, "movie")).toBe(
      true
    );
    expect(isImplausibleEmbedDuration(132, 120 * 60, "movie")).toBe(true);
  });

  it("keeps an alternate cut well above trailer length", () => {
    expect(isImplausibleEmbedDuration(90 * 60, 120 * 60, "movie")).toBe(false);
    expect(isImplausibleEmbedDuration(65 * 60, 120 * 60, "movie")).toBe(false);
  });

  it("does not reject a ~20 min TV episode", () => {
    expect(isImplausibleEmbedDuration(20 * 60, 22 * 60, "tv")).toBe(false);
    expect(isImplausibleEmbedDuration(20 * 60, 24 * 60, "tv")).toBe(false);
  });

  it("does not reject a TV special against a longer series average", () => {
    expect(isImplausibleEmbedDuration(20 * 60, 45 * 60, "tv")).toBe(false);
    expect(isImplausibleEmbedDuration(12 * 60, 12 * 60, "tv")).toBe(false);
  });

  it("fails open when observed or expected runtime is unknown", () => {
    expect(isImplausibleEmbedDuration(0, 120 * 60, "movie")).toBe(false);
    expect(isImplausibleEmbedDuration(180, 0, "movie")).toBe(false);
    expect(isImplausibleEmbedDuration(Number.NaN, 120 * 60, "movie")).toBe(false);
  });
});
