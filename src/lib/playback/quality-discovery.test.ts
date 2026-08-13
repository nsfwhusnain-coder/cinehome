/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  advanceMaximumStartupGate,
  preferredQualityDiscoveryPending,
  shouldWaitForMaximumFourK,
} from "./quality-discovery";
import type { PlaybackResponse, PlaybackSource } from "./types";

function source(id: string, maxHeight: number): PlaybackSource {
  return {
    id,
    url: `https://licensed.example/${id}.m3u8`,
    provider: "Licensed CDN",
    label: "HLS",
    quality: `${maxHeight}p`,
    type: "hls",
    maxHeight,
    verified: true,
  };
}

function response(sources: PlaybackSource[]): PlaybackResponse {
  return {
    status: "available",
    partial: true,
    sources,
    preferences: {
      playbackQuality: 2160,
      audioLanguage: "en",
      audioPreference: "original",
      subtitlePreference: "off",
      fourKStartup: "fast",
    },
  };
}

describe("preferred quality discovery", () => {
  it("keeps polling a healthy 1080 roster while Ultra enrichment is open", () => {
    expect(
      preferredQualityDiscoveryPending(
        response([source("one", 1080), source("two", 1080), source("three", 1080)])
      )
    ).toBe(true);
  });

  it("stops the Ultra hunt when a playable 4K source arrives", () => {
    expect(
      preferredQualityDiscoveryPending(
        response([source("one", 1080), source("ultra", 2160)])
      )
    ).toBe(false);
  });

  it("holds explicit Maximum startup for the full 4K result", () => {
    const maximum = response([source("fast-hd", 1080)]);
    maximum.preferences!.fourKStartup = "maximum";

    expect(shouldWaitForMaximumFourK(maximum, true)).toBe(true);
    expect(shouldWaitForMaximumFourK(maximum, false)).toBe(false);
    maximum.sources = [source("ultra", 2160)];
    expect(shouldWaitForMaximumFourK(maximum, true)).toBe(false);
  });

  it("does not hide an established 1080 roster during background polling", () => {
    const maximum = response([source("fallback-hd", 1080)]);
    maximum.preferences!.fourKStartup = "maximum";

    const initialFullResolveOpen = true;
    expect(shouldWaitForMaximumFourK(maximum, initialFullResolveOpen)).toBe(true);

    expect(shouldWaitForMaximumFourK(maximum, true, true)).toBe(false);
  });

  it("does not release Maximum startup before the first response arrives", () => {
    const initial = { target: "", released: false };
    const target = "movie:550:2160:maximum";
    const pending = advanceMaximumStartupGate(initial, target, undefined, false);
    const maximum = response([source("fast-hd", 1080)]);
    maximum.preferences!.fourKStartup = "maximum";

    expect(pending).toEqual({ target, released: false });
    expect(advanceMaximumStartupGate(pending, target, maximum, true)).toBe(
      pending
    );
    expect(advanceMaximumStartupGate(pending, target, maximum, false)).toEqual({
      target,
      released: true,
    });
  });
});
