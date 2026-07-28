/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  countAutoPlayableRosterSources,
  countMeasuredPlayableRosterSources,
  partialForPlayableRoster,
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
});
