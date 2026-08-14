import "server-only";
import { db } from "@/lib/db";
import {
  AUDIO_PREFERENCE_SETTING_KEY,
  AUDIO_LANGUAGE_SETTING_KEY,
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  FOUR_K_STARTUP_SETTING_KEY,
  HIDE_ADULT_SETTING_KEY,
  PLAYBACK_QUALITY_SETTING_KEY,
  SUBTITLE_PREFERENCE_SETTING_KEY,
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parseHideAdultPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
  type ProfilePlaybackPreferences,
} from "@/lib/profile-preferences";

export async function getUserPlaybackPreferences(
  userId: string
): Promise<ProfilePlaybackPreferences> {
  const rows = await db.userSetting.findMany({
    where: {
      userId,
      key: {
        in: [
          PLAYBACK_QUALITY_SETTING_KEY,
          AUDIO_LANGUAGE_SETTING_KEY,
          AUDIO_PREFERENCE_SETTING_KEY,
          SUBTITLE_PREFERENCE_SETTING_KEY,
          FOUR_K_STARTUP_SETTING_KEY,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    playbackQuality:
      parsePlaybackQualityPreference(values.get(PLAYBACK_QUALITY_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.playbackQuality,
    audioLanguage:
      normalizeAudioLanguage(values.get(AUDIO_LANGUAGE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioLanguage,
    audioPreference:
      parseAudioPreference(values.get(AUDIO_PREFERENCE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.audioPreference,
    subtitlePreference:
      parseSubtitlePreference(values.get(SUBTITLE_PREFERENCE_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.subtitlePreference,
    fourKStartup:
      parseFourKStartupPreference(values.get(FOUR_K_STARTUP_SETTING_KEY)) ??
      DEFAULT_PROFILE_PLAYBACK_PREFERENCES.fourKStartup,
  };
}

export async function saveUserPlaybackPreferences(
  userId: string,
  preferences: ProfilePlaybackPreferences
): Promise<void> {
  await db.$transaction([
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: PLAYBACK_QUALITY_SETTING_KEY },
      },
      update: { value: String(preferences.playbackQuality) },
      create: {
        userId,
        key: PLAYBACK_QUALITY_SETTING_KEY,
        value: String(preferences.playbackQuality),
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: AUDIO_LANGUAGE_SETTING_KEY },
      },
      update: { value: preferences.audioLanguage },
      create: {
        userId,
        key: AUDIO_LANGUAGE_SETTING_KEY,
        value: preferences.audioLanguage,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: AUDIO_PREFERENCE_SETTING_KEY },
      },
      update: { value: preferences.audioPreference },
      create: {
        userId,
        key: AUDIO_PREFERENCE_SETTING_KEY,
        value: preferences.audioPreference,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: SUBTITLE_PREFERENCE_SETTING_KEY },
      },
      update: { value: preferences.subtitlePreference },
      create: {
        userId,
        key: SUBTITLE_PREFERENCE_SETTING_KEY,
        value: preferences.subtitlePreference,
      },
    }),
    db.userSetting.upsert({
      where: {
        userId_key: { userId, key: FOUR_K_STARTUP_SETTING_KEY },
      },
      update: { value: preferences.fourKStartup },
      create: {
        userId,
        key: FOUR_K_STARTUP_SETTING_KEY,
        value: preferences.fourKStartup,
      },
    }),
  ]);
}

export async function getHideAdultPreference(userId: string): Promise<boolean> {
  const row = await db.userSetting.findUnique({
    where: { userId_key: { userId, key: HIDE_ADULT_SETTING_KEY } },
    select: { value: true },
  });
  return parseHideAdultPreference(row?.value);
}

export async function saveHideAdultPreference(
  userId: string,
  hideAdult: boolean
): Promise<void> {
  await db.userSetting.upsert({
    where: { userId_key: { userId, key: HIDE_ADULT_SETTING_KEY } },
    update: { value: hideAdult ? "on" : "off" },
    create: { userId, key: HIDE_ADULT_SETTING_KEY, value: hideAdult ? "on" : "off" },
  });
}
