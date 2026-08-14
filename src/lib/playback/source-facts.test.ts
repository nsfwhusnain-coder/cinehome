/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  inferAudioLanguageFromText,
  isEnglishPreferredSource,
  isPackSource,
  sourceAudioLanguageCode,
  sourceAudioLanguageRank,
} from "./source-facts";
import type { PlaybackSource } from "./types";

function src(overrides: Partial<PlaybackSource>): PlaybackSource {
  return {
    id: "x",
    url: "https://example.test/x",
    provider: "CinemaOS",
    label: "Cinema",
    quality: "1080p",
    type: "mp4",
    ...overrides,
  };
}

describe("source facts", () => {
  it("prefers a stamped language over the display label", () => {
    const source = src({ label: "Eos", audioLanguage: "hi" });
    expect(sourceAudioLanguageCode(source)).toBe("hi");
    expect(isEnglishPreferredSource(source)).toBe(false);
  });

  it("treats unlabeled Cinema / Luna / Kronos as English-household", () => {
    expect(inferAudioLanguageFromText("Cinema CinemaOS")).toBe("und");
    expect(inferAudioLanguageFromText("Luna Vixsrc")).toBe("und");
    expect(sourceAudioLanguageRank(src({ label: "Cinema HI", audioLanguage: "hi" }))).toBe(
      0
    );
    expect(sourceAudioLanguageRank(src({ label: "Luna", provider: "Vixsrc" }))).toBe(1);
    expect(
      sourceAudioLanguageRank(src({ label: "Cinema", audioLanguage: "en" }))
    ).toBe(3);
  });

  it("keeps anime Japanese below English but above Hindi", () => {
    const ja = src({ audioLanguage: "ja", label: "Cinema JA" });
    const en = src({ audioLanguage: "en", label: "Cinema" });
    expect(sourceAudioLanguageRank(ja, "anime")).toBe(1);
    expect(sourceAudioLanguageRank(en, "anime")).toBe(3);
    expect(sourceAudioLanguageRank(ja)).toBe(0);
  });

  it("flags collection dumps as packs", () => {
    expect(
      isPackSource(src({ titleMatch: "pack", label: "Complete Collection" }))
    ).toBe(true);
    expect(isPackSource(src({ titleMatch: "exact", origin: "debrid" }))).toBe(false);
  });
});
