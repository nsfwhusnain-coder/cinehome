import { describe, expect, it } from "bun:test";
import { shouldConsumePlaybackResolveBudget } from "./resolve-budget-policy";

describe("playback resolve budget cache policy", () => {
  it("does not charge an ordinary full cache hit", () => {
    expect(
      shouldConsumePlaybackResolveBudget({
        fast: false,
        refreshMode: "none",
        cache: "HIT",
      })
    ).toBe(false);
  });

  it("charges an ordinary full cache miss", () => {
    expect(
      shouldConsumePlaybackResolveBudget({
        fast: false,
        refreshMode: "none",
        cache: "MISS",
      })
    ).toBe(true);
  });

  it("charges a forced refresh at the pre-cache bypass stage", () => {
    expect(
      shouldConsumePlaybackResolveBudget({
        fast: false,
        refreshMode: "recovery",
        cache: "BYPASS",
      })
    ).toBe(true);
    expect(
      shouldConsumePlaybackResolveBudget({
        fast: false,
        refreshMode: "admin",
        cache: "BYPASS",
      })
    ).toBe(true);
  });

  it("never charges fast or prefetch requests", () => {
    for (const cache of ["HIT", "MISS", "BYPASS"] as const) {
      expect(
        shouldConsumePlaybackResolveBudget({
          fast: true,
          refreshMode: "none",
          cache,
        })
      ).toBe(false);
    }
  });
});
