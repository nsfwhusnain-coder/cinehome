import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import {
  normalizeAudioLanguage,
  parsePlaybackQualityPreference,
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

  let body: { playbackQuality?: unknown; audioLanguage?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const playbackQuality = parsePlaybackQualityPreference(body.playbackQuality);
  const audioLanguage = normalizeAudioLanguage(body.audioLanguage);
  if (playbackQuality == null || audioLanguage == null) {
    return NextResponse.json(
      {
        error:
          "Playback quality must be Auto, 4K, 1440p, 1080p, 720p, 480p, or 360p and audio language must be valid.",
      },
      { status: 400 }
    );
  }

  const preferences = { playbackQuality, audioLanguage };
  await saveUserPlaybackPreferences(userId, preferences);
  return NextResponse.json(preferences, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
