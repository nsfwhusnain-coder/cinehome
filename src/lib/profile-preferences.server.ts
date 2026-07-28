import "server-only";
import { db } from "@/lib/db";
import {
  AUDIO_LANGUAGE_SETTING_KEY,
  DEFAULT_PROFILE_PLAYBACK_PREFERENCES,
  PLAYBACK_QUALITY_SETTING_KEY,
  normalizeAudioLanguage,
  parsePlaybackQualityPreference,
  type ProfilePlaybackPreferences,
} from "@/lib/profile-preferences";

export async function getUserPlaybackPreferences(
  userId: string
): Promise<ProfilePlaybackPreferences> {
  const rows = await db.userSetting.findMany({
    where: {
      userId,
      key: { in: [PLAYBACK_QUALITY_SETTING_KEY, AUDIO_LANGUAGE_SETTING_KEY] },
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
  ]);
}
