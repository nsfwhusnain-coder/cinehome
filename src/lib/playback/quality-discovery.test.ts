/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  advanceMaximumStartupGate,
  preferredQualityDiscoveryPending,
  shouldWaitForMaximumFourK,
  ULTRA_STARTUP_HOLD_MS,
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

  it("holds Ultra startup until a 4K source exists", () => {
    const ultra = response([source("fast-hd", 1080)]);

    expect(shouldWaitForMaximumFourK(ultra, true)).toBe(true);
    expect(shouldWaitForMaximumFourK(ultra, false)).toBe(false);
    ultra.sources = [source("ultra", 2160)];
    expect(shouldWaitForMaximumFourK(ultra, true)).toBe(false);
  });

  it("releases Ultra hold after the startup budget so titles without 4K still play", () => {
    const ultra = response([source("fast-hd", 1080)]);
    expect(ULTRA_STARTUP_HOLD_MS).toBeGreaterThanOrEqual(45_000);
    expect(shouldWaitForMaximumFourK(ultra, true, true)).toBe(false);
  });

  it("still waits on a remembered 1080 roster when Ultra is on and discovery is open", () => {
    const remembered = response([source("luna", 1080)]);
    remembered.partial = undefined;
    expect(shouldWaitForMaximumFourK(remembered, true)).toBe(true);
    remembered.sources = [source("luna", 1080), source("quasar", 2160)];
    expect(shouldWaitForMaximumFourK(remembered, true)).toBe(false);
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
