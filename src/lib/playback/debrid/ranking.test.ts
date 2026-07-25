/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { pickDefaultSource, qualityBadge, scoreSource } from "../source-quality";
import type { PlaybackSource } from "../types";

/**
 * Debrid tier ranking regression coverage (source-quality.ts): a 4K/1080p
 * debrid source should outrank an embed 1080p source, but a Safari-only
 * (HEVC/HDR/MKV) debrid release must never outrank — or become the
 * auto-default over — something the owner's Chrome can actually decode.
 * Tests run under bun (no `window`), matching Chrome-without-HEVC-support.
 */

const debridNative4k: PlaybackSource = {
  id: "debrid-tt0-2160p",
  url: "https://real-debrid.com/d/native4k",
  provider: "Debrid",
  quality: "2160p",
  label: "4K • Debrid",
  type: "mp4",
  maxHeight: 2160,
  origin: "debrid",
  compat: "native",
  codec: "h264",
};

const debridNative1080p: PlaybackSource = {
  id: "debrid-tt0-1080p",
  url: "https://real-debrid.com/d/native1080",
  provider: "Debrid",
  quality: "1080p",
  label: "1080p • Debrid",
  type: "mp4",
  maxHeight: 1080,
  origin: "debrid",
  compat: "native",
  codec: "h264",
};

const embed1080pHls: PlaybackSource = {
  id: "solstice-1080p",
  url: "https://cdn.example.com/master.m3u8",
  provider: "vidking",
  quality: "1080p",
  label: "Solstice",
  type: "hls",
  maxHeight: 1080,
};

const debridSafari4kHevc: PlaybackSource = {
  id: "debrid-tt0-2160p-hevc",
  url: "https://real-debrid.com/d/hevc4k",
  provider: "Debrid",
  quality: "2160p",
  label: "4K • Debrid · Safari",
  type: "mp4",
  maxHeight: 2160,
  origin: "debrid",
  compat: "safari",
  codec: "hevc",
};

describe("scoreSource — debrid tier", () => {
  it("4K H.264 debrid outranks embed 1080p", () => {
    expect(scoreSource(debridNative4k)).toBeGreaterThan(scoreSource(embed1080pHls));
  });

  it("1080p H.264 debrid outranks embed 1080p (strong debrid bonus)", () => {
    expect(scoreSource(debridNative1080p)).toBeGreaterThan(scoreSource(embed1080pHls));
  });

  it("4K HEVC Safari-only debrid ranks below native H.264 1080p (never auto-default on Chrome)", () => {
    expect(scoreSource(debridSafari4kHevc)).toBeLessThan(scoreSource(embed1080pHls));
    expect(scoreSource(debridSafari4kHevc)).toBeLessThan(scoreSource(debridNative1080p));
  });
});

describe("pickDefaultSource — debrid tier", () => {
  it("prefers the native-compat 4K debrid source over embed 1080p and Safari-only 4K debrid", () => {
    const sources = [embed1080pHls, debridSafari4kHevc, debridNative4k];
    const best = pickDefaultSource(sources);
    expect(best?.id).toBe(debridNative4k.id);
  });

  it("never auto-defaults to a Safari-only debrid source when a native option exists", () => {
    const sources = [debridSafari4kHevc, embed1080pHls];
    const best = pickDefaultSource(sources);
    expect(best?.id).toBe(embed1080pHls.id);
  });
});

describe("qualityBadge — debrid tier", () => {
  it('shows "4K (Debrid)" / "1080p (Debrid)" for debrid sources', () => {
    expect(qualityBadge(debridNative4k)).toBe("4K (Debrid)");
    expect(qualityBadge(debridNative1080p)).toBe("1080p (Debrid)");
  });

  it("leaves embed badges unchanged", () => {
    expect(qualityBadge(embed1080pHls)).toBe("1080p");
  });
});
