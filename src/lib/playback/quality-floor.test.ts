/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  failsQualityFloor,
  filterHighQualitySources,
  isLeanDeclaredBitrate,
} from "./quality-floor";

describe("isLeanDeclaredBitrate", () => {
  it("treats a 2.5 Mbps 1080p as too thin", () => {
    expect(isLeanDeclaredBitrate(1080, 2_500_000)).toBe(true);
    expect(isLeanDeclaredBitrate(1080, 4_500_000)).toBe(false);
  });

  it("does not invent a lean verdict when bitrate is unknown", () => {
    expect(isLeanDeclaredBitrate(1080, 0)).toBe(false);
    expect(isLeanDeclaredBitrate(2160, undefined)).toBe(false);
  });
});

describe("filterHighQualitySources", () => {
  it("drops a CAM when a real HD row exists", () => {
    const kept = filterHighQualitySources([
      { label: "Movie 2026 HDCAM", maxHeight: 1080, url: "https://cam.test/a" },
      { label: "Kronos", maxHeight: 1080, bitrateBps: 10_000_000, url: "https://rd.test/b" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe("Kronos");
  });

  it("drops a skinny 1080p when a rich encode exists", () => {
    const kept = filterHighQualitySources([
      { label: "Luna", maxHeight: 1080, bitrateBps: 2_200_000, url: "https://luna.test/a" },
      { label: "Kronos", maxHeight: 1080, bitrateBps: 11_000_000, url: "https://rd.test/b" },
    ]);
    expect(kept.map((source) => source.label)).toEqual(["Kronos"]);
  });

  it("drops 480p when 1080p is already on the roster", () => {
    const kept = filterHighQualitySources([
      { label: "Pulse 480", maxHeight: 480, url: "https://p.test/a" },
      { label: "Luna", maxHeight: 1080, url: "https://luna.test/b" },
    ]);
    expect(kept.map((source) => source.label)).toEqual(["Luna"]);
  });

  it("keeps a cam or a lean row when it is the only source", () => {
    expect(
      filterHighQualitySources([
        { label: "Movie HDCAM", maxHeight: 1080, url: "https://cam.test/a" },
      ])
    ).toHaveLength(1);
    expect(
      filterHighQualitySources([
        { label: "Luna", maxHeight: 1080, bitrateBps: 2_000_000, url: "https://luna.test/a" },
      ])
    ).toHaveLength(1);
  });

  it("keeps a 480p-only roster so last-resort titles still play", () => {
    expect(
      filterHighQualitySources([
        { label: "Pulse 480", maxHeight: 480, url: "https://p.test/a" },
      ])
    ).toHaveLength(1);
  });

  it("does not treat unknown-rate HD as a floor failure", () => {
    expect(
      failsQualityFloor({ label: "Luna", maxHeight: 1080, url: "https://luna.test/a" })
    ).toBe(false);
  });
});
