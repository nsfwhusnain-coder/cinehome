export const PLAYBACK_QUALITY_SETTING_KEY = "playback_quality";
export const AUDIO_LANGUAGE_SETTING_KEY = "audio_language";

export const PLAYBACK_QUALITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 320] as const;
export type PlaybackQualityHeight = (typeof PLAYBACK_QUALITY_HEIGHTS)[number];
export type PlaybackQualityPreference = "auto" | PlaybackQualityHeight;

export interface ProfilePlaybackPreferences {
  playbackQuality: PlaybackQualityPreference;
  audioLanguage: string;
}

export const DEFAULT_PROFILE_PLAYBACK_PREFERENCES: ProfilePlaybackPreferences = {
  playbackQuality: "auto",
  audioLanguage: "en",
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
