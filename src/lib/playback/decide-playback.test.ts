/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { decidePlayback } from "./decide-playback";
import type { PlaybackSource } from "./types";

function src(overrides: Partial<PlaybackSource> & { id: string }): PlaybackSource {
  return {
    url: `https://example.test/${overrides.id}`,
    provider: overrides.provider ?? "test",
    label: overrides.label ?? overrides.id,
    quality: overrides.quality ?? "1080p",
    type: overrides.type ?? "mp4",
    codec: "h264",
    ...overrides,
  };
}

const hindi1080 = src({
  id: "cinema-hi",
  provider: "CinemaOS",
  label: "Cinema HI",
  audioLanguage: "hi",
  maxHeight: 1080,
  container: "mp4",
});
const arabic1080 = src({
  id: "cinema-ar",
  provider: "CinemaOS",
  label: "Cinema AR",
  audioLanguage: "ar",
  maxHeight: 1080,
  container: "mp4",
});
const luna = src({
  id: "luna",
  provider: "Vixsrc",
  label: "Luna",
  audioLanguage: "und",
  type: "hls",
  maxHeight: 1080,
});
const kronos = src({
  id: "kronos",
  provider: "Debrid",
  origin: "debrid",
  label: "1080p • Debrid",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mp4",
  compat: "native",
  maxHeight: 1080,
});
const hades = src({
  id: "hades",
  provider: "Debrid",
  origin: "debrid",
  label: "4K • Debrid · Safari",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mkv",
  compat: "native",
  maxHeight: 2160,
});
const poseidon = src({
  id: "poseidon",
  provider: "Debrid",
  origin: "debrid",
  label: "4K • Debrid",
  audioLanguage: "en",
  titleMatch: "exact",
  container: "mp4",
  compat: "native",
  maxHeight: 2160,
});
const pack4k = src({
  id: "pack",
  provider: "Debrid",
  origin: "debrid",
  label: "Complete Collection 2160p",
  audioLanguage: "en",
  titleMatch: "pack",
  container: "mp4",
  maxHeight: 2160,
});

describe("decidePlayback contract", () => {
  it("starts direct 4K once when Ultra is selected, never remux-then-reload", () => {
    const decision = decidePlayback([hindi1080, hades, luna], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("luna");
    expect(decision.deferredFourK?.id).toBe("hades");
  });

  it("starts Kronos over Hindi, remux, and Arabic", () => {
    const decision = decidePlayback([hindi1080, arabic1080, hades, kronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
    expect(decision.deferredFourK?.id).toBe("hades");
  });

  it("plays remux 4K when the only other HD is Hindi", () => {
    const decision = decidePlayback([hindi1080, hades], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("hades");
    expect(decision.deferredFourK).toBeNull();
  });

  it("never auto-defaults a pack when an exact title exists", () => {
    const decision = decidePlayback([pack4k, kronos], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("Ultra starts Luna instead of a pack 4K posing as Kronos", () => {
    const decision = decidePlayback([pack4k, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("luna");
  });

  it("starts native 4K immediately and does not defer remux", () => {
    const decision = decidePlayback([poseidon, kronos, hades], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("poseidon");
    expect(decision.deferredFourK).toBeNull();
  });

  it("maximum still refuses Hindi 4K when English HD exists", () => {
    const hindi4k = src({
      id: "cinema-hi-4k",
      provider: "CinemaOS",
      label: "Cinema HI",
      audioLanguage: "hi",
      maxHeight: 2160,
      container: "mp4",
    });
    const decision = decidePlayback([hindi4k, luna], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("luna");
  });

  it("stamped English Kronos beats unlabeled Luna", () => {
    const decision = decidePlayback([luna, kronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("starts direct HD when Ultra has remux 4K but no Quasar/Poseidon", () => {
    const decision = decidePlayback([luna, hades], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("luna");
    expect(decision.deferredFourK?.id).toBe("hades");
  });

  it("auto may still fast-start HD while remux 4K is deferred", () => {
    const decision = decidePlayback([luna, hades], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("luna");
    expect(decision.deferredFourK?.id).toBe("hades");
  });

  it("starts the rich native 1080p, not a skinny labelled 1080p", () => {
    const leanLuna = src({
      id: "lean-luna",
      provider: "Vixsrc",
      label: "Luna",
      audioLanguage: "en",
      type: "hls",
      maxHeight: 1080,
      bitrateBps: 2_200_000,
    });
    const richKronos = src({
      ...kronos,
      bitrateBps: 12_000_000,
    });
    const decision = decidePlayback([leanLuna, richKronos], {
      preferredHeight: "auto",
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("kronos");
  });

  it("drops failed ids before ranking", () => {
    const decision = decidePlayback([kronos, luna], {
      fourKStartup: "fast",
      failedIds: ["kronos"],
    });
    expect(decision.immediate?.id).toBe("luna");
  });
});
