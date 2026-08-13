/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  playbackPollRefetchCount,
  playbackQueryKey,
} from "./use-playback";

describe("playback query discovery identity", () => {
  it("partitions cached rosters by quality and 4K startup policy", () => {
    const hd = playbackQueryKey("movie", 550, undefined, undefined, false, "1080:fast");
    const fast4k = playbackQueryKey("movie", 550, undefined, undefined, false, "2160:fast");
    const maximum4k = playbackQueryKey(
      "movie",
      550,
      undefined,
      undefined,
      false,
      "2160:maximum"
    );

    expect(hd).not.toEqual(fast4k);
    expect(fast4k).not.toEqual(maximum4k);
  });

  it("resets polling allowance against the current mount baseline", () => {
    expect(playbackPollRefetchCount(1, 0)).toBe(0);
    expect(playbackPollRefetchCount(6, 0)).toBe(5);
    expect(playbackPollRefetchCount(12, 12)).toBe(0);
    expect(playbackPollRefetchCount(13, 12)).toBe(1);
  });
});
