/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { buildPlaybackUrl } from "./playback-preresolve";

describe("buildPlaybackUrl season index", () => {
  it("sends season 0 specials instead of coercing to S1", () => {
    const url = buildPlaybackUrl("tv", 1399, 0, 1, true);
    const params = new URL(url, "https://cinehome.local").searchParams;
    expect(params.get("season")).toBe("0");
    expect(params.get("episode")).toBe("1");
  });

  it("defaults omitted TV indexes to S1E1", () => {
    const url = buildPlaybackUrl("tv", 1399, undefined, undefined, true);
    const params = new URL(url, "https://cinehome.local").searchParams;
    expect(params.get("season")).toBe("1");
    expect(params.get("episode")).toBe("1");
  });
});
