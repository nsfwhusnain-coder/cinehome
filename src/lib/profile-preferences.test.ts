import { describe, expect, it } from "bun:test";
import {
  normalizeAudioLanguage,
  parsePlaybackQualityPreference,
} from "./profile-preferences";

describe("profile playback preferences", () => {
  it("defaults are validated independently of browser storage", () => {
    expect(parsePlaybackQualityPreference("auto")).toBe("auto");
    expect(parsePlaybackQualityPreference("2160")).toBe(2160);
    expect(parsePlaybackQualityPreference(720)).toBe(720);
    expect(parsePlaybackQualityPreference(320)).toBe(320);
    expect(parsePlaybackQualityPreference("best")).toBeNull();
  });

  it("normalizes supported language tags and rejects arbitrary text", () => {
    expect(normalizeAudioLanguage(" EN ")).toBe("en");
    expect(normalizeAudioLanguage("pt-BR")).toBe("pt-br");
    expect(normalizeAudioLanguage("../secret")).toBeNull();
  });
});
