/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { filterHighQualitySources, isLeanDeclaredBitrate } from "./quality-floor";

describe("scraper quality floor", () => {
  it("drops a 2.5 Mbps 1080p when a rich encode exists", () => {
    expect(isLeanDeclaredBitrate(1080, 2_500_000)).toBe(true);
    const kept = filterHighQualitySources([
      { label: "Luna", maxHeight: 1080, bitrateBps: 2_500_000, url: "https://a.test/l" },
      { label: "Kronos", maxHeight: 1080, bitrateBps: 12_000_000, url: "https://a.test/k" },
    ]);
    expect(kept.map((source) => source.label)).toEqual(["Kronos"]);
  });

  it("never empties a one-row roster", () => {
    expect(
      filterHighQualitySources([
        { label: "HDCAM", maxHeight: 1080, url: "https://a.test/c" },
      ])
    ).toHaveLength(1);
  });
});
