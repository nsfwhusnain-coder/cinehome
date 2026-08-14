/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { VERIFIED_MIN_SKIP_SECONDARY } from "./embed-roster";
import {
  countAutoPlayableRosterSources,
  countMeasuredPlayableRosterSources,
  partialForPlayableRoster,
  rosterHasPlayableHeight,
  shouldSkipPlaywrightForHealthyRoster,
} from "./roster-health";

describe("playable roster completion", () => {
  it("does not let a large dead roster close progressive discovery", () => {
    const dead = Array.from({ length: 8 }, (_, index) => ({
      url: `https://cdn.example/dead-${index}.mp4`,
      probe: { ok: false },
    }));
    expect(countAutoPlayableRosterSources(dead)).toBe(0);
    expect(partialForPlayableRoster(dead, 2)).toBe(true);
  });

  it("counts only healthy, non-poison sources toward the clear floor", () => {
    const sources = [
      { url: "https://cdn.example/one.m3u8", probe: { ok: true } },
      { url: "https://cdn.example/two.mp4", verified: true },
      {
        url: "https://aqua-vulture-337623.hostingersite.com/vid1.php",
        probe: { ok: true },
      },
    ];
    expect(countAutoPlayableRosterSources(sources)).toBe(2);
    expect(partialForPlayableRoster(sources, 2)).toBeUndefined();
  });

  it("requires positive evidence before suppressing fallback providers", () => {
    const sources = [
      { url: "https://unknown.example/video.mp4" },
      { url: "https://verified.example/video.mp4", verified: true },
      { url: "https://probe.example/video.m3u8", probe: { ok: true } },
      { url: "https://dead.example/video.mp4", probe: { ok: false } },
    ];
    expect(countMeasuredPlayableRosterSources(sources)).toBe(2);
  });

  it("keeps Ultra discovery open until a playable 4K source appears", () => {
    const hd = Array.from({ length: 4 }, (_, index) => ({
      url: `https://cdn.example/hd-${index}.m3u8`,
      verified: true,
      maxHeight: 1080,
    }));
    const uhd = {
      url: "https://cdn.example/uhd.m3u8",
      verified: true,
      ladder: [2160, 1080, 720],
    };

    expect(rosterHasPlayableHeight(hd, 2160)).toBe(false);
    expect(rosterHasPlayableHeight([...hd, uhd], 2160)).toBe(true);
  });

  it("skips primary Playwright once 4 measured-playable APIs exist", () => {
    const healthy = Array.from({ length: VERIFIED_MIN_SKIP_SECONDARY }, (_, index) => ({
      url: `https://cdn.example/${index}.m3u8`,
      probe: { ok: true as const },
    }));
    expect(shouldSkipPlaywrightForHealthyRoster(healthy)).toBe(true);
    expect(shouldSkipPlaywrightForHealthyRoster(healthy.slice(0, 3))).toBe(false);
  });
});
