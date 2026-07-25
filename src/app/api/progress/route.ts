import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getAuthenticatedUserId } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Per-user watch progress (continue watching).
 *
 * GET    /api/progress                — list (progress < 0.95, newest first, limit 20)
 * POST   /api/progress                — upsert { tmdbId, mediaType, title, poster, backdrop, progress, position, duration, season?, episode?, providerId? }
 * DELETE /api/progress?tmdbId=...&mediaType=...&season=...&episode=... — remove (TV: specific episode when season+episode given)
 *
 * Deploy: run `npx prisma db push` after schema change. Migrate existing movie rows:
 *   UPDATE WatchProgress SET season = 0, episode = 0 WHERE mediaType = 'movie';
 */

const MEDIA_TYPES = new Set(["movie", "tv"]);

/** Movies use 0/0 so SQLite UNIQUE has a single stable key per title. */
function resolveSeasonEpisode(
  mediaType: string,
  season?: number | null,
  episode?: number | null
): { season: number; episode: number } | { error: string } {
  if (mediaType === "movie") {
    return { season: 0, episode: 0 };
  }
  if (season == null || episode == null || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return { error: "TV progress requires season and episode" };
  }
  return { season: Number(season), episode: Number(episode) };
}

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch extra rows so TV multi-episode progress still yields ~20 unique titles after collapse.
  const items = await db.watchProgress.findMany({
    where: { userId, progress: { lt: 0.95 } },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });

  // One card per show: keep the most recently updated episode (already newest-first).
  const seen = new Set<string>();
  const collapsed: typeof items = [];
  for (const row of items) {
    const key =
      row.mediaType === "tv" ? `tv:${row.tmdbId}` : `movie:${row.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(row);
    if (collapsed.length >= 20) break;
  }

  return NextResponse.json(collapsed);
}

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    tmdbId: number;
    mediaType: string;
    title?: string;
    poster?: string | null;
    backdrop?: string | null;
    progress: number;
    position?: number;
    duration?: number;
    season?: number | null;
    episode?: number | null;
    providerId?: string | null;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.tmdbId || !body.mediaType || typeof body.progress !== "number") {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  if (!MEDIA_TYPES.has(body.mediaType)) {
    return NextResponse.json({ error: "mediaType must be movie or tv" }, { status: 400 });
  }

  const resolved = resolveSeasonEpisode(body.mediaType, body.season, body.episode);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  if (body.duration == null || !Number.isFinite(body.duration) || body.duration <= 0) {
    return NextResponse.json({ error: "duration is required" }, { status: 400 });
  }

  const progress = Math.min(1, Math.max(0, body.progress));
  const tmdbId = Number(body.tmdbId);

  try {
    const item = await db.watchProgress.upsert({
      where: {
        userId_tmdbId_mediaType_season_episode: {
          userId,
          tmdbId,
          mediaType: body.mediaType,
          season: resolved.season,
          episode: resolved.episode,
        },
      },
      update: {
        title: body.title,
        poster: body.poster ?? null,
        backdrop: body.backdrop ?? null,
        progress,
        position: body.position ?? 0,
        duration: body.duration,
        providerId: body.providerId ?? null,
      },
      create: {
        userId,
        tmdbId,
        mediaType: body.mediaType,
        title: body.title,
        poster: body.poster ?? null,
        backdrop: body.backdrop ?? null,
        progress,
        position: body.position ?? 0,
        duration: body.duration,
        season: resolved.season,
        episode: resolved.episode,
        providerId: body.providerId ?? null,
      },
    });

    return NextResponse.json(item);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return NextResponse.json({ error: "Session expired — please sign in again" }, { status: 401 });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tmdbId = url.searchParams.get("tmdbId");
  const mediaType = url.searchParams.get("mediaType");
  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "Missing tmdbId or mediaType" }, { status: 400 });
  }

  if (!MEDIA_TYPES.has(mediaType)) {
    return NextResponse.json({ error: "mediaType must be movie or tv" }, { status: 400 });
  }

  const baseWhere = { userId, tmdbId: Number(tmdbId), mediaType };

  if (mediaType === "movie") {
    await db.watchProgress.deleteMany({
      where: { ...baseWhere, season: 0, episode: 0 },
    });
  } else if (seasonParam != null && episodeParam != null) {
    await db.watchProgress.deleteMany({
      where: {
        ...baseWhere,
        season: Number(seasonParam),
        episode: Number(episodeParam),
      },
    });
  } else {
    await db.watchProgress.deleteMany({ where: baseWhere });
  }

  return NextResponse.json({ ok: true });
}