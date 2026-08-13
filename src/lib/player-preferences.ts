import {
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
  playbackDiscoveryPreferenceKey,
  type AudioPreference,
  type FourKStartupPreference,
  type PlaybackQualityPreference,
  type ProfilePlaybackPreferences,
  type SubtitlePreference,
} from "@/lib/profile-preferences";

const PREFERRED_PROVIDER_KEY = "cinehome:preferred-provider";
const PREFERRED_QUALITY_KEY = "cinehome:preferred-quality";
const PLAYBACK_SPEED_KEY = "cinehome:playback-speed";
const PREFERRED_AUDIO_LANG_KEY = "cinehome:audio-lang";
const AUDIO_PREFERENCE_KEY = "cinehome:audio-preference";
const SUBTITLE_PREFERENCE_KEY = "cinehome:subtitle-preference";
const FOUR_K_STARTUP_KEY = "cinehome:four-k-startup";
/**
 * Quality-floor policy. "adaptive" (default, Netflix-style): under sustained
 * bandwidth starvation, temporarily drop below the 1080 floor to keep video
 * playing, then climb back when the line recovers. "absolute": never below
 * 1080p — buffer at the floor indefinitely instead (the old "Absolute Cinema
 * 1080p" brand behavior).
 */
const QUALITY_FLOOR_POLICY_KEY = "cinehome:quality-floor-policy";
export type QualityFloorPolicy = "adaptive" | "absolute";
export const DEFAULT_FLOOR_POLICY: QualityFloorPolicy = "adaptive";

export function getQualityFloorPolicy(): QualityFloorPolicy {
  if (typeof window === "undefined") return DEFAULT_FLOOR_POLICY;
  const raw = localStorage.getItem(QUALITY_FLOOR_POLICY_KEY);
  return raw === "absolute" ? "absolute" : "adaptive";
}

export function setQualityFloorPolicy(policy: QualityFloorPolicy): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(QUALITY_FLOOR_POLICY_KEY, policy);
}

/**
 * Default stream preference key.
 * Empty → pure probe/rank pick (Aether/Horizon/Solstice beat Luna).
 * Avoid baking "Luna" here — it was stranding users on the slow CDN.
 */
export const DEFAULT_SOURCE_KEY = "";

export function getPreferredProvider(): string {
  if (typeof window === "undefined") return DEFAULT_SOURCE_KEY;
  return localStorage.getItem(PREFERRED_PROVIDER_KEY) || DEFAULT_SOURCE_KEY;
}

export function setPreferredProvider(provider: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PREFERRED_PROVIDER_KEY, provider);
}

/**
 * Preferred height in pixels (e.g. 1080, 2160) or auto.
 * Product rule: **1080p minimum** — never return a preference below 1080.
 * "auto" = ABR among 1080 / 1440 / 4K only (player enforces floor).
 */
export function getPreferredQualityHeight(): PlaybackQualityPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality;
  }
  const raw = localStorage.getItem(PREFERRED_QUALITY_KEY);
  return (
    parsePlaybackQualityPreference(raw) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality
  );
}

export function setPreferredQualityHeight(height: PlaybackQualityPreference): void {
  if (typeof window === "undefined") return;
  const normalized = parsePlaybackQualityPreference(height);
  localStorage.setItem(
    PREFERRED_QUALITY_KEY,
    String(normalized ?? DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality)
  );
}

export function getSavedPlaybackSpeed(): number {
  if (typeof window === "undefined") return 1;
  const raw = localStorage.getItem(PLAYBACK_SPEED_KEY);
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function setSavedPlaybackSpeed(speed: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PLAYBACK_SPEED_KEY, String(speed));
}

export const DEFAULT_AUDIO_LANGUAGE = "en";

export function getPreferredAudioLanguage(): string {
  if (typeof window === "undefined") return DEFAULT_AUDIO_LANGUAGE;
  return (
    normalizeAudioLanguage(localStorage.getItem(PREFERRED_AUDIO_LANG_KEY)) ||
    DEFAULT_AUDIO_LANGUAGE
  );
}

export function setPreferredAudioLanguage(lang: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    PREFERRED_AUDIO_LANG_KEY,
    normalizeAudioLanguage(lang) || DEFAULT_AUDIO_LANGUAGE
  );
}

export function getAudioPreference(): AudioPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference;
  }
  return (
    parseAudioPreference(localStorage.getItem(AUDIO_PREFERENCE_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference
  );
}

export function setAudioPreference(preference: AudioPreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    AUDIO_PREFERENCE_KEY,
    parseAudioPreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference
  );
}

export function getSubtitlePreference(): SubtitlePreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference;
  }
  return (
    parseSubtitlePreference(localStorage.getItem(SUBTITLE_PREFERENCE_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference
  );
}

export function setSubtitlePreference(preference: SubtitlePreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    SUBTITLE_PREFERENCE_KEY,
    parseSubtitlePreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference
  );
}

export function getFourKStartupPreference(): FourKStartupPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup;
  }
  return (
    parseFourKStartupPreference(localStorage.getItem(FOUR_K_STARTUP_KEY)) ??
    DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
  );
}

export function getPlaybackDiscoveryPreferenceKey(): string {
  try {
    return playbackDiscoveryPreferenceKey(
      getPreferredQualityHeight(),
      getFourKStartupPreference()
    );
  } catch {
    return playbackDiscoveryPreferenceKey(
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality,
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
    );
  }
}

export function setFourKStartupPreference(
  preference: FourKStartupPreference
): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    FOUR_K_STARTUP_KEY,
    parseFourKStartupPreference(preference) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup
  );
}

/** Hydrate the low-latency browser cache from the authenticated profile API. */
export function syncProfilePlaybackPreferences(
  preferences: ProfilePlaybackPreferences
): void {
  setPreferredQualityHeight(preferences.playbackQuality);
  setPreferredAudioLanguage(preferences.audioLanguage);
  setAudioPreference(preferences.audioPreference);
  setSubtitlePreference(preferences.subtitlePreference);
  setFourKStartupPreference(preferences.fourKStartup);
}
