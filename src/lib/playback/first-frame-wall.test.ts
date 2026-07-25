/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  FIRST_FRAME_WALL_COLD_MS,
  FIRST_FRAME_WALL_RESUME_MS,
  FIRST_FRAME_WALL_RESUME_THRESHOLD_S,
  firstFrameWallMs,
} from "./first-frame-wall";

describe("firstFrameWallMs (R8 dead-CDN wall)", () => {
  it("cold start multi-source → wall covers large media level load (R10)", () => {
    const ms = firstFrameWallMs({ resumeAt: 0, remainingSources: 2 });
    expect(ms).toBe(FIRST_FRAME_WALL_COLD_MS);
    // Must exceed typical Vixsrc media playlist first-hop latency (~10–20s).
    expect(ms).toBeGreaterThanOrEqual(18_000);
    expect(ms).toBeLessThanOrEqual(25_000);
  });

  it("cold start with null/absent resumeAt and multi-source → cold wall", () => {
    expect(firstFrameWallMs({ remainingSources: 1 })).toBe(FIRST_FRAME_WALL_COLD_MS);
    expect(firstFrameWallMs({ resumeAt: null, remainingSources: 3 })).toBe(
      FIRST_FRAME_WALL_COLD_MS
    );
  });

  it("resume just at threshold is still cold (not mid-title)", () => {
    expect(
      firstFrameWallMs({
        resumeAt: FIRST_FRAME_WALL_RESUME_THRESHOLD_S,
        remainingSources: 2,
      })
    ).toBe(FIRST_FRAME_WALL_COLD_MS);
  });

  it("resume >5s multi-source → patient wall ≥ cold wall", () => {
    const ms = firstFrameWallMs({ resumeAt: 120, remainingSources: 2 });
    expect(ms).toBe(FIRST_FRAME_WALL_RESUME_MS);
    expect(ms).toBeGreaterThanOrEqual(FIRST_FRAME_WALL_COLD_MS);
  });

  it("sole remaining source uses patient wall (not aggressive cold)", () => {
    // Cold position but nowhere to fail over — do not kill into empty early.
    expect(firstFrameWallMs({ resumeAt: 0, remainingSources: 0 })).toBe(
      FIRST_FRAME_WALL_RESUME_MS
    );
    expect(firstFrameWallMs({ resumeAt: 90, remainingSources: 0 })).toBe(
      FIRST_FRAME_WALL_RESUME_MS
    );
  });

  it("negative remainingSources clamps to sole-source policy", () => {
    expect(firstFrameWallMs({ resumeAt: 0, remainingSources: -1 })).toBe(
      FIRST_FRAME_WALL_RESUME_MS
    );
  });
});
