/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { findLateFourKSource, wantsFourKDiscovery } from "./late-fourk";
import type { PlaybackSource } from "./types";

function source(overrides: Partial<PlaybackSource>): PlaybackSource {
  return {
    id: overrides.id ?? "src",
    url: overrides.url ?? `https://example.test/${overrides.id ?? "src"}.m3u8`,
    provider: overrides.provider ?? "Test",
    quality: overrides.quality ?? "auto",
    label: overrides.label ?? "Server",
    type: overrides.type ?? "hls",
    ...overrides,
  };
}

describe("wantsFourKDiscovery", () => {
  it("only Ultra hunts a different 4K source", () => {
    expect(wantsFourKDiscovery("auto")).toBe(false);
    expect(wantsFourKDiscovery(null)).toBe(false);
    expect(wantsFourKDiscovery(2160)).toBe(true);
  });

  it("respects an explicit HD or lower cap", () => {
    expect(wantsFourKDiscovery(1080)).toBe(false);
    expect(wantsFourKDiscovery(720)).toBe(false);
  });
});

describe("findLateFourKSource", () => {
  const playing1080 = source({
    id: "hd",
    maxHeight: 1080,
    probe: { ok: true, ttfbMs: 40, bytesPerSec: 4_000_000, speedScore: 70 },
  });
  const direct4k = source({
    id: "uhd",
    maxHeight: 2160,
    type: "mp4",
    codec: "h264",
    container: "mp4",
    origin: "embed",
    probe: { ok: true, ttfbMs: 50, bytesPerSec: 8_000_000, speedScore: 80 },
  });

  it("does not remount Auto onto a late 4K source", () => {
    expect(
      findLateFourKSource(playing1080, [playing1080, direct4k], {
        preferredHeight: "auto",
      })
    ).toBeNull();
  });

  it("adopts a probed direct 4K after HD has already started when Ultra is on", () => {
    expect(
      findLateFourKSource(playing1080, [playing1080, direct4k], {
        preferredHeight: 2160,
      })?.id
    ).toBe("uhd");
  });

  it("adopts an unprobed direct 4K when Ultra is the preset", () => {
    const unproven = source({
      id: "maybe-4k",
      maxHeight: 2160,
      type: "hls",
    });
    expect(
      findLateFourKSource(playing1080, [playing1080, unproven], {
        preferredHeight: 2160,
      })?.id
    ).toBe("maybe-4k");
  });

  it("adopts remux 4K when Ultra is on and no direct 4K exists", () => {
    const remux4k = source({
      id: "remux-4k",
      maxHeight: 2160,
      type: "mp4",
      codec: "h264",
      container: "mkv",
      origin: "debrid",
      compat: "native",
      probe: { ok: true, ttfbMs: 20, bytesPerSec: 12_000_000, speedScore: 90 },
    });
    expect(
      findLateFourKSource(playing1080, [playing1080, remux4k], {
        preferredHeight: 2160,
      })?.id
    ).toBe("remux-4k");
  });

  it("does not upgrade when the profile is locked to 1080p", () => {
    expect(
      findLateFourKSource(playing1080, [playing1080, direct4k], {
        preferredHeight: 1080,
      })
    ).toBeNull();
  });

  it("does not switch away from an already-playing 4K", () => {
    expect(
      findLateFourKSource(direct4k, [playing1080, direct4k], {
        preferredHeight: 2160,
      })
    ).toBeNull();
  });
});
