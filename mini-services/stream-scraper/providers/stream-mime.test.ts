/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  hasStreamExtension,
  isCaptureWorthySize,
  isLikelyVideoMime,
  labelFromMime,
  MIME_CAPTURE_MIN_BYTES,
} from "./stream-mime";

/**
 * Broadened interception classifier (robustness item — see
 * .claude/handoffs/agent-l-embeds.md). Extends the Playwright capture layer
 * beyond plain .m3u8/.mp4/.mpd extension matching so segments served from
 * extension-less/obfuscated CDN paths (seen live on a couple of probed
 * candidate hosts) are still recognized via Content-Type.
 */
describe("hasStreamExtension", () => {
  it("recognizes all four stream extensions, query string included", () => {
    expect(hasStreamExtension("https://cdn.example/master.m3u8?token=abc")).toBe(true);
    expect(hasStreamExtension("https://cdn.example/video.mpd")).toBe(true);
    expect(hasStreamExtension("https://cdn.example/file.mp4?sign=xyz")).toBe(true);
    expect(hasStreamExtension("https://cdn.example/seg-0001.m4s")).toBe(true);
  });

  it("is false for a plain HTML/JS asset", () => {
    expect(hasStreamExtension("https://cdn.example/app.js")).toBe(false);
    expect(hasStreamExtension("https://embed.example/")).toBe(false);
  });
});

describe("isLikelyVideoMime", () => {
  it("matches HLS/DASH manifest and TS/MP4 segment content-types", () => {
    expect(isLikelyVideoMime("application/vnd.apple.mpegurl")).toBe(true);
    expect(isLikelyVideoMime("application/x-mpegURL; charset=utf-8")).toBe(true);
    expect(isLikelyVideoMime("application/dash+xml")).toBe(true);
    expect(isLikelyVideoMime("video/mp2t")).toBe(true);
    expect(isLikelyVideoMime("video/mp4")).toBe(true);
  });

  it("does not match unrelated content-types", () => {
    expect(isLikelyVideoMime("application/json")).toBe(false);
    expect(isLikelyVideoMime("text/html; charset=utf-8")).toBe(false);
    expect(isLikelyVideoMime("image/png")).toBe(false);
    expect(isLikelyVideoMime("")).toBe(false);
  });
});

describe("labelFromMime", () => {
  it("maps mpegurl -> HLS, dash+xml -> DASH, else MP4", () => {
    expect(labelFromMime("application/vnd.apple.mpegurl")).toBe("HLS");
    expect(labelFromMime("application/dash+xml")).toBe("DASH");
    expect(labelFromMime("video/mp4")).toBe("MP4");
    expect(labelFromMime("video/mp2t")).toBe("MP4");
  });
});

describe("isCaptureWorthySize", () => {
  it("treats unknown size (chunked transfer) as worth capturing", () => {
    expect(isCaptureWorthySize(null)).toBe(true);
  });

  it("rejects small bodies below the floor (ad pixel / error JSON mislabeled as video)", () => {
    expect(isCaptureWorthySize(500)).toBe(false);
    expect(isCaptureWorthySize(MIME_CAPTURE_MIN_BYTES - 1)).toBe(false);
  });

  it("accepts bodies at/above the floor", () => {
    expect(isCaptureWorthySize(MIME_CAPTURE_MIN_BYTES)).toBe(true);
    expect(isCaptureWorthySize(5_000_000)).toBe(true);
  });
});
