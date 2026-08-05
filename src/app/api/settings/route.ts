import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEFAULT_PROVIDER_ID, listProviders } from "@/lib/playback";
import { FLAG_DEFAULTS, invalidateAppFlag } from "@/lib/feature-flags";

/**
 * Server-wide settings (TMDB API key override, playback provider, appearance).
 *
 * GET    /api/settings          — read all settings (admin sees full, user sees redacted)
 * POST   /api/settings          — update settings (admin only)
 *   body: { tmdb_api_key?, playback_provider?, theme?, accent_color?,
 *           flag_ui_bottom_nav?, flag_ui_hubs?, flag_playback_fast_path? }
 */

const ADMIN_ONLY_KEYS = ["tmdb_api_key"]; // not exposed to non-admins

// Secrets that must NEVER be serialized to any client, admin included. The
// Real-Debrid token is managed via /api/debrid/status and only ever leaves the
// server as account metadata, never as the raw token.
const SECRET_KEYS = ["realdebrid_token"];

const FLAG_KEYS = Object.keys(FLAG_DEFAULTS);

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await db.appSetting.findMany();
  const out: Record<string, string> = {};
  for (const s of settings) {
    if (SECRET_KEYS.includes(s.key)) {
      continue; // never leaves the server
    }
    if (ADMIN_ONLY_KEYS.includes(s.key) && !user.isAdmin) {
      continue;
    }
    out[s.key] = s.value;
  }
  if (!out.playback_provider) out.playback_provider = DEFAULT_PROVIDER_ID;
  for (const [key, def] of Object.entries(FLAG_DEFAULTS)) {
    if (!out[key]) out[key] = def;
  }

  const status = {
    tmdb: !!out.tmdb_api_key || !!process.env.TMDB_API_KEY,
    playbackProvider: out.playback_provider,
  };

  // Non-admins only ever need their own playback prefs + flags. The provider
  // registry and server status stay admin-only — this used to ship the full
  // payload (including providers + status) to every signed-in user.
  if (!user.isAdmin) {
    const nonAdminKeys = ["playback_provider", ...FLAG_KEYS];
    for (const key of Object.keys(out)) {
      if (!nonAdminKeys.includes(key)) delete out[key];
    }
    return NextResponse.json({
      settings: out,
      status: { tmdb: false, playbackProvider: out.playback_provider },
      isAdmin: false,
      providers: [],
    });
  }

  return NextResponse.json({ settings: out, status, isAdmin: true, providers: listProviders() });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json()) as Record<string, string | undefined>;
  const allowed = [
    "tmdb_api_key",
    "playback_provider",
    "theme",
    "accent_color",
    ...FLAG_KEYS,
  ];

  for (const key of allowed) {
    const val = body[key];
    if (val === undefined) continue; // not provided — don't touch
    if (val === "") {
      // clear
      await db.appSetting.deleteMany({ where: { key } });
    } else {
      await db.appSetting.upsert({
        where: { key },
        update: { value: val },
        create: { key, value: val },
      });
    }
    if (key.startsWith("flag_")) invalidateAppFlag(key);
  }

  return NextResponse.json({ ok: true });
}
