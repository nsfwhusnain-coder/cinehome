export const PLAYBACK_QUALITY_SETTING_KEY = "playback_quality";
export const AUDIO_LANGUAGE_SETTING_KEY = "audio_language";
export const AUDIO_PREFERENCE_SETTING_KEY = "audio_preference";
export const SUBTITLE_PREFERENCE_SETTING_KEY = "subtitle_preference";
export const FOUR_K_STARTUP_SETTING_KEY = "four_k_startup";
/** Household catalog filter. UserSetting KV: on | off. Default on. */
export const HIDE_ADULT_SETTING_KEY = "hide_adult";

export const PLAYBACK_QUALITY_HEIGHTS = [2160, 1080, 720, 480, 360] as const;
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
  playbackQuality: 2160,
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
  if (!Number.isFinite(parsed)) return null;
  // 1440p was retired — almost no title has that rung. Old Ultra-adjacent
  // "Higher" profiles become Ultra so 4K still wins when it exists.
  if (parsed === 1440) return 2160;
  return PLAYBACK_QUALITY_SET.has(parsed)
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

/** Default ON. Only an explicit off/0/false turns the household filter off. */
export function parseHideAdultPreference(value: unknown): boolean {
  if (value === "off" || value === "0" || value === false || value === "false") {
    return false;
  }
  return true;
}

/** Cache identity for source discovery; non-4K startup policy cannot change it. */
export function playbackDiscoveryPreferenceKey(
  quality: PlaybackQualityPreference,
  fourKStartup: FourKStartupPreference
): string {
  const startup = quality === 2160 ? fourKStartup : "fast";
  return `${quality}:${startup}`;
}
