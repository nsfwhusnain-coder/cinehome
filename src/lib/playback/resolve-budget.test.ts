/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { RateLimiter } from "@/lib/rate-limit";
import { consumePlaybackResolveBudget } from "./resolve-budget";

describe("playback resolve budget ordering", () => {
  it("does not let a closed title drain the user's reserved recovery capacity", () => {
    const titleLimiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    const userLimiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
    const normal = {
      titleLimiter,
      userLimiter,
      userKey: "user-1",
      titleKey: "user-1:movie:1",
      consumeTitle: true,
    };

    expect(consumePlaybackResolveBudget(normal).allowed).toBe(true);
    const denied = consumePlaybackResolveBudget(normal);
    expect(denied).toMatchObject({ allowed: false, deniedScope: "title" });

    const recovery = consumePlaybackResolveBudget({
      ...normal,
      consumeTitle: false,
    });
    expect(recovery).toEqual({
      allowed: true,
      retryAfterMs: 0,
      deniedScope: null,
    });
  });
});
