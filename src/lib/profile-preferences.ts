export const PLAYBACK_QUALITY_SETTING_KEY = "playback_quality";
export const AUDIO_LANGUAGE_SETTING_KEY = "audio_language";
export const AUDIO_PREFERENCE_SETTING_KEY = "audio_preference";
export const SUBTITLE_PREFERENCE_SETTING_KEY = "subtitle_preference";
export const FOUR_K_STARTUP_SETTING_KEY = "four_k_startup";

export const PLAYBACK_QUALITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360] as const;
export type PlaybackQualityHeight = (typeof PLAYBACK_QUALITY_HEIGHTS)[number];
export type PlaybackQualityPreference = "auto" | PlaybackQualityHeight;
export type AudioPreference = "original" | "english" | "preferred";
export type SubtitlePreference = "english" | "off";
export type FourKStartupPreference = "fast" | "maximum";

export interface ProfilePlaybackPreferences {
  playbackQuality: PlaybackQualityPreference;
  audioLanguage: string;
  audioPreference: AudioPreference;
  subtitlePreference: SubtitlePreference;
  fourKStartup: FourKStartupPreference;
}

export const DEFAULT_PROFILE_PLAYBACK_PREFERENCES: ProfilePlaybackPreferences = {
  playbackQuality: "auto",
  audioLanguage: "en",
  audioPreference: "original",
  subtitlePreference: "english",
  fourKStartup: "fast",
};

const PLAYBACK_QUALITY_SET = new Set<number>(PLAYBACK_QUALITY_HEIGHTS);

export function parsePlaybackQualityPreference(
  value: unknown
): PlaybackQualityPreference | null {
  if (value === "auto") return "auto";
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && PLAYBACK_QUALITY_SET.has(parsed)
    ? (parsed as PlaybackQualityHeight)
    : null;
}

export function normalizeAudioLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized)
    ? normalized
    : null;
}

export function parseAudioPreference(value: unknown): AudioPreference | null {
  return value === "original" || value === "english" || value === "preferred"
    ? value
    : null;
}

export function parseSubtitlePreference(value: unknown): SubtitlePreference | null {
  return value === "english" || value === "off" ? value : null;
}

export function parseFourKStartupPreference(
  value: unknown
): FourKStartupPreference | null {
  return value === "fast" || value === "maximum" ? value : null;
}
