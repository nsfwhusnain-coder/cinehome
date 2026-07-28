/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  isPlaybackRateLimited,
  PlaybackRequestError,
  shouldRetryPlaybackRequest,
} from "./request-error";

describe("playback request retry policy", () => {
  it("treats an HTTP 429 as terminal for retries and progressive polling", () => {
    const error = new PlaybackRequestError("wait", 429);
    expect(isPlaybackRateLimited(error)).toBe(true);
    expect(shouldRetryPlaybackRequest(0, error)).toBe(false);
  });

  it("keeps one retry for a transient resolver failure", () => {
    const error = new PlaybackRequestError("upstream unavailable", 503);
    expect(isPlaybackRateLimited(error)).toBe(false);
    expect(shouldRetryPlaybackRequest(0, error)).toBe(true);
    expect(shouldRetryPlaybackRequest(1, error)).toBe(false);
  });
});
