import { describe, expect, it } from "bun:test";
import {
  parseDashTopBitrate,
  parseHlsMasterRenditions,
  topRenditionBitrate,
} from "./quality-probe";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=1498000,RESOLUTION=854x480",
  "480.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2996000,RESOLUTION=1280x720",
  "720.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=5350000,RESOLUTION=1920x1080",
  "1080.m3u8",
].join("\n");

describe("parseHlsMasterRenditions", () => {
  it("pairs each variant's height with its bitrate", () => {
    expect(parseHlsMasterRenditions(MASTER)).toEqual([
      { height: 480, bandwidthBps: 1_498_000 },
      { height: 720, bandwidthBps: 2_996_000 },
      { height: 1080, bandwidthBps: 5_350_000 },
    ]);
  });

  it("prefers AVERAGE-BANDWIDTH over the peak ceiling", () => {
    const text =
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,AVERAGE-BANDWIDTH=6000000,RESOLUTION=1920x1080\nv.m3u8";
    expect(parseHlsMasterRenditions(text)[0]?.bandwidthBps).toBe(6_000_000);
  });

  it("does not read AVERAGE-BANDWIDTH into the peak slot", () => {
    // A bare /BANDWIDTH=/ also matches the tail of AVERAGE-BANDWIDTH=.
    const text =
      "#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=6000000,RESOLUTION=1920x1080\nv.m3u8";
    expect(parseHlsMasterRenditions(text)[0]?.bandwidthBps).toBe(6_000_000);
  });

  it("returns nothing for a media playlist", () => {
    const media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts";
    expect(parseHlsMasterRenditions(media)).toEqual([]);
  });
});

describe("topRenditionBitrate", () => {
  it("takes the bitrate of the tallest rung, not the fattest", () => {
    expect(topRenditionBitrate(parseHlsMasterRenditions(MASTER))).toBe(5_350_000);
  });

  it("breaks a height tie on the richer encode", () => {
    expect(
      topRenditionBitrate([
        { height: 1080, bandwidthBps: 4_000_000 },
        { height: 1080, bandwidthBps: 9_000_000 },
      ])
    ).toBe(9_000_000);
  });

  it("returns 0 when no variant declares a bitrate", () => {
    expect(topRenditionBitrate([{ height: 1080, bandwidthBps: 0 }])).toBe(0);
    expect(topRenditionBitrate([])).toBe(0);
  });
});

describe("parseDashTopBitrate", () => {
  it("takes the highest declared Representation bandwidth", () => {
    const mpd =
      '<AdaptationSet><Representation height="720" bandwidth="2500000"/>' +
      '<Representation height="1080" bandwidth="6200000"/></AdaptationSet>';
    expect(parseDashTopBitrate(mpd)).toBe(6_200_000);
  });

  it("returns 0 when the manifest declares none", () => {
    expect(parseDashTopBitrate('<Representation height="1080"/>')).toBe(0);
  });
});
