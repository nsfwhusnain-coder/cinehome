/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  NEXT_EP_PRELOAD_RATIO,
  shouldPrefetchNextEpisode,
} from "./next-episode-prefetch";

const ready = {
  alreadyPreloaded: false,
  mediaType: "tv",
  tvId: 1399,
  hasNextTarget: true,
  progressDuration: 100,
  currentTime: 0,
};

describe("shouldPrefetchNextEpisode", () => {
  it("fires at the 45% binge mark, not only in the last fifth", () => {
    expect(NEXT_EP_PRELOAD_RATIO).toBe(0.45);
    expect(shouldPrefetchNextEpisode({ ...ready, currentTime: 44 })).toBe(false);
    expect(shouldPrefetchNextEpisode({ ...ready, currentTime: 45 })).toBe(true);
  });

  it("is a no-op for movies, missing targets, or a second call", () => {
    expect(shouldPrefetchNextEpisode({ ...ready, mediaType: "movie", currentTime: 90 })).toBe(
      false
    );
    expect(shouldPrefetchNextEpisode({ ...ready, hasNextTarget: false, currentTime: 90 })).toBe(
      false
    );
    expect(shouldPrefetchNextEpisode({ ...ready, alreadyPreloaded: true, currentTime: 90 })).toBe(
      false
    );
    expect(shouldPrefetchNextEpisode({ ...ready, tvId: null, currentTime: 90 })).toBe(false);
  });
});
