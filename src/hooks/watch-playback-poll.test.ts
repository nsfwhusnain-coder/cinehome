/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  MAX_SOURCE_POLL_REFETCHES,
  POLL_INTERVAL_BASE_MS,
  POLL_INTERVAL_LATER_MS,
  POLL_WALL_MS,
  PREFERRED_QUALITY_POLL_MAX,
  playbackPollRefetchCount,
  watchPlaybackPollInterval,
} from "./watch-playback-poll";

const hunting = {
  rateLimited: false,
  hasFullData: true,
  fetching: false,
  playableCount: 0,
  preferredQualityPending: false,
  extraFetches: 0,
  elapsedMs: 0,
};

describe("watchPlaybackPollInterval", () => {
  it("stops once any playable source exists", () => {
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        playableCount: 1,
      })
    ).toBe(false);
  });

  it("does not keep hunting just because the scraper is still partial", () => {
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        playableCount: 2,
        preferredQualityPending: false,
        extraFetches: 1,
      })
    ).toBe(false);
  });

  it("allows a short preferred-quality follow-up after HD is already playable", () => {
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        playableCount: 2,
        preferredQualityPending: true,
        extraFetches: 0,
      })
    ).toBe(POLL_INTERVAL_LATER_MS);
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        playableCount: 2,
        preferredQualityPending: true,
        extraFetches: PREFERRED_QUALITY_POLL_MAX,
      })
    ).toBe(false);
  });

  it("hunts an empty roster on the fast interval, then stops at the budget", () => {
    expect(watchPlaybackPollInterval(hunting)).toBe(POLL_INTERVAL_BASE_MS);
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        extraFetches: MAX_SOURCE_POLL_REFETCHES,
      })
    ).toBe(false);
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        elapsedMs: POLL_WALL_MS,
      })
    ).toBe(false);
  });

  it("never stacks a poll while the first full request is open", () => {
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        hasFullData: false,
      })
    ).toBe(false);
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        fetching: true,
      })
    ).toBe(false);
  });

  it("stops immediately when the title bucket is rate limited", () => {
    expect(
      watchPlaybackPollInterval({
        ...hunting,
        rateLimited: true,
      })
    ).toBe(false);
  });
});

describe("playbackPollRefetchCount", () => {
  it("resets polling allowance against the current mount baseline", () => {
    expect(playbackPollRefetchCount(1, 0)).toBe(0);
    expect(playbackPollRefetchCount(6, 0)).toBe(5);
    expect(playbackPollRefetchCount(12, 12)).toBe(0);
    expect(playbackPollRefetchCount(13, 12)).toBe(1);
  });
});
