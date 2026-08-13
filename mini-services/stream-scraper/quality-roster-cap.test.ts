/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { capRosterWithQualityReserve } from "./quality-roster-cap";

describe("quality discovery roster cap", () => {
  it("reserves a probe slot for an opaque adaptive source after 20 known HD rows", () => {
    const known = Array.from({ length: 20 }, (_, index) => ({
      url: `https://known.example/${index}.m3u8`,
      provider: `known-${index}`,
      type: "hls" as const,
      maxHeight: 1080,
    }));
    const opaque = {
      url: "https://licensed.example/opaque-master.m3u8",
      provider: "licensed-uhd",
      type: "hls" as const,
      maxHeight: 0,
    };
    const capped = capRosterWithQualityReserve([...known, opaque], 20, 4);

    expect(capped).toHaveLength(20);
    expect(capped).toContainEqual(opaque);
  });

  it("reserves a probe slot for an opaque progressive MP4", () => {
    const known = Array.from({ length: 20 }, (_, index) => ({
      url: `https://known.example/${index}.m3u8`,
      provider: `known-${index}`,
      type: "hls" as const,
      maxHeight: 1080,
    }));
    const opaque = {
      url: "https://licensed.example/media?id=opaque-uhd",
      provider: "licensed-mp4",
      type: "mp4" as const,
      maxHeight: 0,
    };

    expect(capRosterWithQualityReserve([...known, opaque], 20, 4)).toContainEqual(opaque);
  });

  it("reserves a mislabeled candidate for measurement during Ultra discovery", () => {
    const known = Array.from({ length: 20 }, (_, index) => ({
      url: `https://known.example/${index}.m3u8`,
      provider: `known-${index}`,
      type: "hls" as const,
      maxHeight: 1080,
      qualitySource: "manifest" as const,
    }));
    const mislabeled = {
      url: "https://licensed.example/media?id=possible-uhd",
      provider: "licensed-mp4",
      type: "mp4" as const,
      maxHeight: 1080,
      qualitySource: "label" as const,
    };

    expect(
      capRosterWithQualityReserve([...known, mislabeled], 20, 4, 2160)
    ).toContainEqual(mislabeled);
    expect(
      capRosterWithQualityReserve([...known, mislabeled], 20, 4, 1080)
    ).not.toContainEqual(mislabeled);
  });

  it("does not displace ranked rows when no opaque adaptive candidate exists", () => {
    const known = Array.from({ length: 21 }, (_, index) => ({
      url: `https://known.example/${index}.m3u8`,
      provider: `known-${index}`,
      maxHeight: 1080,
    }));

    expect(capRosterWithQualityReserve(known, 20, 4)).toEqual(known.slice(0, 20));
  });

  it("does not reserve dead or poison quality candidates", () => {
    const known = Array.from({ length: 20 }, (_, index) => ({
      url: `https://known.example/${index}.m3u8`,
      provider: `known-${index}`,
      maxHeight: 1080,
    }));
    const dead = {
      url: "https://dead.example/opaque.m3u8",
      provider: "dead",
      type: "hls" as const,
      verified: false,
    };
    const poison = {
      url: "https://bad.hostingersite.com/opaque.m3u8",
      provider: "poison",
      type: "hls" as const,
    };

    expect(
      capRosterWithQualityReserve([...known, dead, poison], 20, 4)
    ).toEqual(known);
  });
});
