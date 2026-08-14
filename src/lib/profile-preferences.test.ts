import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
  playbackDiscoveryPreferenceKey,
} from "./profile-preferences";

describe("profile playback preferences", () => {
  test("validates quality defaults independently of browser storage", () => {
    expect(parsePlaybackQualityPreference("auto")).toBe("auto");
    expect(parsePlaybackQualityPreference("2160")).toBe(2160);
    expect(parsePlaybackQualityPreference(720)).toBe(720);
    expect(parsePlaybackQualityPreference(320)).toBeNull();
    expect(parsePlaybackQualityPreference("best")).toBeNull();
  });

  test("normalizes supported language tags and rejects arbitrary text", () => {
    expect(normalizeAudioLanguage(" EN ")).toBe("en");
    expect(normalizeAudioLanguage("pt-BR")).toBe("pt-br");
    expect(normalizeAudioLanguage("../secret")).toBeNull();
  });

  test("defaults to original audio, English subtitles, and fast 4K startup", () => {
    expect(DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality).toBe(2160);
    expect(DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference).toBe("original");
    expect(DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference).toBe("english");
    expect(DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup).toBe("fast");
  });

  test("rejects unknown policy values", () => {
    expect(parseAudioPreference("commentary")).toBeNull();
    expect(parseSubtitlePreference("all")).toBeNull();
    expect(parseFourKStartupPreference("slow")).toBeNull();
  });

  test("partitions 4K discovery by quality and Maximum startup policy", () => {
    expect(playbackDiscoveryPreferenceKey(2160, "fast")).toBe("2160:fast");
    expect(playbackDiscoveryPreferenceKey(2160, "maximum")).toBe("2160:maximum");
    expect(playbackDiscoveryPreferenceKey(1080, "maximum")).toBe("1080:fast");
  });
});
