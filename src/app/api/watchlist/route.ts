import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getAuthenticatedUserId } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Per-user watchlist API.
 *
 * GET    /api/watchlist                — list user's watchlist
 * POST   /api/watchlist                — add { tmdbId, mediaType, title, poster, backdrop }
 * DELETE /api/watchlist?tmdbId=...&mediaType=... — remove
 */

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const items = await db.watchlistItem.findMany({
    where: { userId },
    orderBy: { addedAt: "desc" },
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    tmdbId: number;
    mediaType: string;
    title: string;
    poster?: string | null;
    backdrop?: string | null;
    voteAverage?: number | null;
    releaseDate?: string | null;
  };

  if (!body.tmdbId || !body.mediaType || !body.title) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  try {
    const item = await db.watchlistItem.upsert({
      where: {
        userId_tmdbId_mediaType: {
          userId,
          tmdbId: Number(body.tmdbId),
          mediaType: body.mediaType,
        },
      },
      update: {
        title: body.title,
        poster: body.poster ?? null,
        backdrop: body.backdrop ?? null,
        voteAverage: body.voteAverage ?? null,
        releaseDate: body.releaseDate ?? null,
      },
      create: {
        userId,
        tmdbId: Number(body.tmdbId),
        mediaType: body.mediaType,
        title: body.title,
        poster: body.poster ?? null,
        backdrop: body.backdrop ?? null,
        voteAverage: body.voteAverage ?? null,
        releaseDate: body.releaseDate ?? null,
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
  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "Missing tmdbId or mediaType" }, { status: 400 });
  }

  await db.watchlistItem.deleteMany({
    where: { userId, tmdbId: Number(tmdbId), mediaType },
  });
  return NextResponse.json({ ok: true });
}
