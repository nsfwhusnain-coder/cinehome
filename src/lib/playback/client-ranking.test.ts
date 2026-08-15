import { describe, expect, test } from "bun:test";
import type { PlaybackSource } from "./types";
import {
  isLanguageRescueUpgrade,
  pickClientStartupSource,
  shouldAdoptRosterUpgrade,
} from "./client-ranking";

function source(
  id: string,
  maxHeight: number,
  container: PlaybackSource["container"]
): PlaybackSource {
  return {
    id,
    url: `https://example.test/${id}`,
    provider: "test",
    label: id,
    quality: `${maxHeight}p`,
    maxHeight,
    type: "mp4",
    codec: "h264",
    container,
    origin: "debrid",
    compat: "native",
  };
}

describe("client startup ranking", () => {
  const remux4k = source("remux-4k", 2160, "mkv");
  const direct1080 = source("direct-1080", 1080, "mp4");
  const direct4k = source("direct-4k", 2160, "mp4");

  test("Ultra starts direct HD, not remux 4K, so the player does not 404", () => {
    const decision = pickClientStartupSource([remux4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-1080");
    expect(decision.deferredFourK?.id).toBe("remux-4k");
  });

  test("maximum mode also starts direct HD and keeps remux 4K deferred", () => {
    const decision = pickClientStartupSource([remux4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("direct-1080");
    expect(decision.deferredFourK?.id).toBe("remux-4k");
  });

  test("direct 4K is never delayed", () => {
    const decision = pickClientStartupSource([direct4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-4k");
    expect(decision.deferredFourK).toBeNull();
  });

  test("keeps 4K remux when no direct HD fallback exists", () => {
    const decision = pickClientStartupSource([remux4k], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("remux-4k");
  });

  test("auto uses the same fast 4K handoff as Ultra", () => {
    const decision = pickClientStartupSource([remux4k, direct1080], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-1080");
    expect(decision.deferredFourK?.id).toBe("remux-4k");
  });

  test("does not defer remux 4K when a direct 4K is already starting", () => {
    const decision = pickClientStartupSource([remux4k, direct4k], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-4k");
    expect(decision.deferredFourK).toBeNull();
  });

  test("does not treat Hindi CinemaOS 1080 as the fast-start HD source", () => {
    const hindi1080: PlaybackSource = {
      id: "cinema-hi",
      url: "https://example.test/cinema-hi.mp4",
      provider: "CinemaOS",
      label: "Cinema HI 1080",
      quality: "1080p",
      maxHeight: 1080,
      type: "mp4",
      codec: "h264",
      container: "mp4",
      origin: "embed",
    };
    const decision = pickClientStartupSource([remux4k, hindi1080], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("remux-4k");
    expect(decision.deferredFourK).toBeNull();
  });

  test("fast-starts English Luna, not Hindi 1080, and still defers remux 4K", () => {
    const hindi1080: PlaybackSource = {
      id: "cinema-hi",
      url: "https://example.test/cinema-hi.mp4",
      provider: "CinemaOS",
      label: "Cinema HI",
      quality: "1080p",
      maxHeight: 1080,
      type: "mp4",
      codec: "h264",
      container: "mp4",
    };
    const luna: PlaybackSource = {
      id: "luna",
      url: "https://example.test/luna.m3u8",
      provider: "Vixsrc",
      label: "Luna",
      quality: "1080p",
      maxHeight: 1080,
      type: "hls",
      codec: "h264",
    };
    const ultra = pickClientStartupSource([hindi1080, remux4k, luna], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(ultra.immediate?.id).toBe("luna");
    expect(ultra.deferredFourK?.id).toBe("remux-4k");

    const auto = pickClientStartupSource([hindi1080, remux4k, luna], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(auto.immediate?.id).toBe("luna");
    expect(auto.deferredFourK?.id).toBe("remux-4k");
  });
});

describe("shouldAdoptRosterUpgrade", () => {
  const remux4k = source("remux-4k", 2160, "mkv");
  const remux1080 = source("remux-1080", 1080, "mkv");
  const direct1080 = source("direct-1080", 1080, "mp4");
  const direct720 = source("direct-720", 720, "mp4");

  test("refuses remux 4K over a selected direct HD before first frame", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: remux4k,
        everPlayed: false,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(false);
  });

  test("allows remux 4K over direct HD only in maximum startup mode", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: remux4k,
        everPlayed: false,
        fourKStartup: "maximum",
        userPicked: false,
      })
    ).toBe(true);
  });

  test("never overrides an explicit user pick or a healthy first frame", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: remux4k,
        everPlayed: false,
        fourKStartup: "maximum",
        userPicked: true,
      })
    ).toBe(false);
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: remux4k,
        everPlayed: true,
        fourKStartup: "maximum",
        userPicked: false,
      })
    ).toBe(false);
  });

  test("still upgrades a remux-only roster toward the taller remux", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: remux1080,
        candidate: remux4k,
        everPlayed: false,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(true);
  });

  test("still allows a taller direct source during cold start", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: direct720,
        candidate: direct1080,
        everPlayed: false,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(true);
  });

  test("rescues Hindi 1080 to English even after first frame", () => {
    const hindi1080: PlaybackSource = {
      ...direct1080,
      id: "cinema-hi",
      provider: "CinemaOS",
      label: "Cinema HI 1080",
      origin: "embed",
    };
    expect(isLanguageRescueUpgrade(hindi1080, remux4k)).toBe(true);
    expect(
      shouldAdoptRosterUpgrade({
        current: hindi1080,
        candidate: remux4k,
        everPlayed: true,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(true);
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: hindi1080,
        everPlayed: false,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(false);
  });
});
