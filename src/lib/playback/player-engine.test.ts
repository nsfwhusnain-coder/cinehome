/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { classifyPlaybackUrl, isSessionExpiredError } from "./player-engine";

describe("classifyPlaybackUrl", () => {
  it("treats remux as HLS and proxied", () => {
    const classified = classifyPlaybackUrl("/api/transcode?mode=remux", "mp4");
    expect(classified.useHls).toBe(true);
    expect(classified.isTranscoded).toBe(true);
    expect(classified.useDash).toBe(false);
  });

  it("does not force HLS on a progressive MP4 through the home proxy", () => {
    const classified = classifyPlaybackUrl("/api/hls/abc", "mp4");
    expect(classified.useHls).toBe(false);
    expect(classified.isProxied).toBe(true);
  });
});

describe("isSessionExpiredError", () => {
  it("detects a 410 session expiry", () => {
    expect(isSessionExpiredError({ response: { code: 410 } })).toBe(true);
    expect(isSessionExpiredError({ details: "ok" })).toBe(false);
  });
});
