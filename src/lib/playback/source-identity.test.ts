/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  dedupePlaybackSources,
  sourceInstanceId,
} from "./source-identity";
import type { PlaybackSource } from "./types";

function source(id: string, url: string, maxHeight: number): PlaybackSource {
  return {
    id,
    url,
    provider: "Licensed CDN",
    quality: `${maxHeight}p`,
    label: "HLS",
    type: "hls",
    maxHeight,
  };
}

function proxyUrl(upstreamUrl: string, headers: Record<string, string>): string {
  const data = encodeURIComponent(JSON.stringify({ url: upstreamUrl, headers }));
  return `https://proxy.example/v1/proxy?data=${data}`;
}

describe("source instance identity", () => {
  it("keeps same-labelled 1080p and 4K URLs independently selectable", () => {
    const hdUrl = "https://media.example/video/1080/master.m3u8?token=one";
    const uhdUrl = "https://media.example/video/2160/master.m3u8?token=two";
    const hd = source(sourceInstanceId("licensed", hdUrl), hdUrl, 1080);
    const uhd = source(sourceInstanceId("licensed", uhdUrl), uhdUrl, 2160);

    expect(dedupePlaybackSources([hd, uhd])).toHaveLength(2);
    expect(hd.id).not.toBe(uhd.id);
  });

  it("keeps ambiguous key selectors that distinguish fixed renditions", () => {
    const hd = "https://media.example/video?id=movie&key=1080&token=one";
    const uhd = "https://media.example/video?id=movie&key=2160&token=two";

    expect(sourceInstanceId("licensed", hd)).not.toBe(
      sourceInstanceId("licensed", uhd)
    );
  });

  it("keeps a stable id when only authentication parameters rotate", () => {
    const first = "https://media.example/video/master.m3u8?token=one&expires=1";
    const renewed = "https://media.example/video/master.m3u8?token=two&expires=2";
    const firstId = sourceInstanceId("licensed", first);
    const renewedId = sourceInstanceId("licensed", renewed);

    expect(renewedId).toBe(firstId);
    expect(
      dedupePlaybackSources([
        source(firstId, first, 2160),
        source(renewedId, renewed, 2160),
      ])
    ).toHaveLength(1);
  });

  it("keeps a stable id when nested URL and header authentication rotate", () => {
    const first = proxyUrl(
      "https://media.example/video/master.m3u8?quality=2160&token=first&expires=1",
      {
        Authorization: "Bearer first",
        Cookie: "session=first",
        Referer: "https://player.example/",
      }
    );
    const renewed = proxyUrl(
      "https://media.example/video/master.m3u8?quality=2160&token=renewed&expires=2",
      {
        authorization: "Bearer renewed",
        cookie: "session=renewed",
        referer: "https://player.example/",
      }
    );

    const firstId = sourceInstanceId("licensed", first);
    const renewedId = sourceInstanceId("licensed", renewed);

    expect(renewedId).toBe(firstId);
    expect(
      dedupePlaybackSources([
        source(firstId, first, 2160),
        source(renewedId, renewed, 2160),
      ])
    ).toHaveLength(1);
  });

  it("keeps distinct nested 1080p and 2160p renditions selectable", () => {
    const hd = proxyUrl(
      "https://media.example/video/1080/master.m3u8?quality=1080&token=first",
      { Referer: "https://player.example/" }
    );
    const uhd = proxyUrl(
      "https://media.example/video/2160/master.m3u8?quality=2160&token=second",
      { Referer: "https://player.example/" }
    );

    const hdSource = source(sourceInstanceId("licensed", hd), hd, 1080);
    const uhdSource = source(sourceInstanceId("licensed", uhd), uhd, 2160);

    expect(hdSource.id).not.toBe(uhdSource.id);
    expect(dedupePlaybackSources([hdSource, uhdSource])).toHaveLength(2);
  });

  it("fails closed without throwing for malformed or oversized proxy data", () => {
    const malformed = "https://proxy.example/v1/proxy?data=%7Bbroken";
    const oversizedData = encodeURIComponent("x".repeat(40_000));
    const oversized = `https://proxy.example/v1/proxy?data=${oversizedData}`;

    expect(() => sourceInstanceId("licensed", malformed)).not.toThrow();
    expect(() => sourceInstanceId("licensed", oversized)).not.toThrow();
    expect(sourceInstanceId("licensed", malformed)).not.toBe(
      sourceInstanceId("licensed", oversized)
    );
  });
});
