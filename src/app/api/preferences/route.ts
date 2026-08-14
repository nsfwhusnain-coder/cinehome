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
  getHideAdultPreference,
  getUserPlaybackPreferences,
  saveHideAdultPreference,
  saveUserPlaybackPreferences,
} from "@/lib/profile-preferences.server";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [preferences, hideAdult] = await Promise.all([
    getUserPlaybackPreferences(userId),
    getHideAdultPreference(userId),
  ]);
  return NextResponse.json(
    { ...preferences, hideAdult },
    { headers: { "Cache-Control": "private, no-store" } }
  );
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
    hideAdult?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.hideAdult === "boolean" && body.playbackQuality === undefined) {
    await saveHideAdultPreference(userId, body.hideAdult);
    return NextResponse.json(
      { hideAdult: body.hideAdult },
      { headers: { "Cache-Control": "private, no-store" } }
    );
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
  if (typeof body.hideAdult === "boolean") {
    await saveHideAdultPreference(userId, body.hideAdult);
  }
  const hideAdult =
    typeof body.hideAdult === "boolean"
      ? body.hideAdult
      : await getHideAdultPreference(userId);
  return NextResponse.json(
    { ...preferences, hideAdult },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
