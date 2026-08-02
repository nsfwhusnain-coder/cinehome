import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import {
  normalizeAudioLanguage,
  parseAudioPreference,
  parseFourKStartupPreference,
  parsePlaybackQualityPreference,
  parseSubtitlePreference,
} from "@/lib/profile-preferences";
import {
  getUserPlaybackPreferences,
  saveUserPlaybackPreferences,
} from "@/lib/profile-preferences.server";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await getUserPlaybackPreferences(userId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PATCH(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    playbackQuality?: unknown;
    audioLanguage?: unknown;
    audioPreference?: unknown;
    subtitlePreference?: unknown;
    fourKStartup?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const playbackQuality = parsePlaybackQualityPreference(body.playbackQuality);
  const audioLanguage = normalizeAudioLanguage(body.audioLanguage);
  const audioPreference = parseAudioPreference(body.audioPreference);
  const subtitlePreference = parseSubtitlePreference(body.subtitlePreference);
  const fourKStartup = parseFourKStartupPreference(body.fourKStartup);
  if (
    playbackQuality == null ||
    audioLanguage == null ||
    audioPreference == null ||
    subtitlePreference == null ||
    fourKStartup == null
  ) {
    return NextResponse.json(
      {
        error:
          "Playback quality, audio, subtitle, or 4K startup preference is invalid.",
      },
      { status: 400 }
    );
  }

  const preferences = {
    playbackQuality,
    audioLanguage,
    audioPreference,
    subtitlePreference,
    fourKStartup,
  };
  await saveUserPlaybackPreferences(userId, preferences);
  return NextResponse.json(preferences, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
