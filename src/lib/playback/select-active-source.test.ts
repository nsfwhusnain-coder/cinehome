/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { reducePlaybackPhase } from "./playback-session";
import {
  selectActiveSource,
  shouldAdoptRosterUpgrade,
} from "./select-active-source";
import type { PlaybackSource } from "./types";

function src(
  id: string,
  maxHeight: number,
  extras: Partial<PlaybackSource> = {}
): PlaybackSource {
  return {
    id,
    url: `https://example.test/${id}`,
    provider: extras.provider ?? "Debrid",
    label: extras.label ?? id,
    quality: `${maxHeight}p`,
    maxHeight,
    type: "mp4",
    codec: "h264",
    origin: extras.origin ?? "debrid",
    compat: "native",
    audioLanguage: extras.audioLanguage ?? "en",
    ...extras,
  };
}

const remux4k = src("remux-4k", 2160, { container: "mkv" });
const direct1080 = src("direct-1080", 1080, { container: "mp4" });
const hindi1080 = src("cinema-hi", 1080, {
  provider: "CinemaOS",
  label: "Cinema HI",
  origin: "embed",
  audioLanguage: "hi",
  container: "mp4",
});

describe("selectActiveSource", () => {
  it("Ultra starts direct HD once and does not remount after first frame", () => {
    const started = selectActiveSource({
      roster: [remux4k, direct1080],
      active: null,
      userPicked: false,
      everPlayed: false,
      autoUpgraded: false,
      fourKStartup: "fast",
      preferredHeight: 2160,
    });
    expect(started.next?.id).toBe("direct-1080");
    expect(started.replace).toBe(true);

    const held = selectActiveSource({
      roster: [remux4k, direct1080],
      active: direct1080,
      userPicked: false,
      everPlayed: true,
      autoUpgraded: true,
      fourKStartup: "fast",
      preferredHeight: 2160,
    });
    expect(held.replace).toBe(false);
    expect(held.next?.id).toBe("direct-1080");
  });

  it("rescues a Hindi start to English remux after first frame", () => {
    const rescue = selectActiveSource({
      roster: [hindi1080, remux4k],
      active: hindi1080,
      userPicked: false,
      everPlayed: true,
      autoUpgraded: false,
      fourKStartup: "fast",
      preferredHeight: 2160,
    });
    expect(rescue.replace).toBe(true);
    expect(rescue.next?.id).toBe("remux-4k");
    expect(rescue.reason).toBe("language_rescue");
  });

  it("does not remount a playing source to a richer encode", () => {
    const lean = src("lean-luna", 1080, {
      origin: "embed",
      provider: "Vixsrc",
      bitrateBps: 2_200_000,
      container: "mp4",
    });
    const rich = src("rich-kronos", 1080, {
      bitrateBps: 12_000_000,
      container: "mp4",
    });
    const upgrade = selectActiveSource({
      roster: [lean, rich],
      active: lean,
      userPicked: false,
      everPlayed: true,
      autoUpgraded: false,
      fourKStartup: "fast",
      preferredHeight: 2160,
    });
    expect(upgrade.replace).toBe(false);
    expect(upgrade.next?.id).toBe("lean-luna");
  });

  it("does not remount a playing remux 4K onto late Quasar", () => {
    const quasar = src("quasar-4k", 2160, {
      origin: "embed",
      provider: "Videasy",
      label: "Quasar",
      type: "hls",
      container: undefined,
    });
    expect(
      shouldAdoptRosterUpgrade({
        current: remux4k,
        candidate: quasar,
        everPlayed: true,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(false);

    const switched = selectActiveSource({
      roster: [remux4k, quasar],
      active: remux4k,
      userPicked: false,
      everPlayed: true,
      autoUpgraded: true,
      fourKStartup: "fast",
      preferredHeight: 2160,
    });
    expect(switched.replace).toBe(false);
    expect(switched.next?.id).toBe("remux-4k");
  });

  it("does not switch a playing native HD stream to remux 4K", () => {
    expect(
      shouldAdoptRosterUpgrade({
        current: direct1080,
        candidate: remux4k,
        everPlayed: true,
        fourKStartup: "fast",
        userPicked: false,
      })
    ).toBe(false);
  });

  it("does not let Hindi steal an English HD start", () => {
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

describe("playback session", () => {
  it("moves idle → attaching → playing and stays sticky until failure", () => {
    const attaching = reducePlaybackPhase("idle", { type: "roster_ready" });
    expect(attaching).toBe("attaching");
    expect(reducePlaybackPhase(attaching, { type: "first_frame" })).toBe("playing");
    expect(reducePlaybackPhase("playing", { type: "source_failed" })).toBe("failing");
  });
});
