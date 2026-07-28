/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { verifiedInventoryIsHealthy } from "./provider-inventory";

describe("verified provider inventory circuit outcome", () => {
  it("keeps a genuine title miss healthy for providers with that contract", () => {
    expect(
      verifiedInventoryIsHealthy(
        { rawCount: 0, playable: [] },
        { emptyIsTitleMiss: true }
      )
    ).toBe(true);
  });

  it("marks returned-but-unplayable inventory unhealthy", () => {
    expect(
      verifiedInventoryIsHealthy(
        { rawCount: 4, playable: [] },
        { emptyIsTitleMiss: true }
      )
    ).toBe(false);
  });

  it("marks verified playable inventory healthy", () => {
    expect(
      verifiedInventoryIsHealthy(
        { rawCount: 4, playable: ["stream"] },
        { emptyIsTitleMiss: true }
      )
    ).toBe(true);
  });

  it("supports providers whose empty result is an outage signal", () => {
    expect(
      verifiedInventoryIsHealthy(
        { rawCount: 0, playable: [] },
        { emptyIsTitleMiss: false }
      )
    ).toBe(false);
  });
});
