import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Admin user management.
 *
 * GET    /api/admin/users         — list all users with stats
 * DELETE /api/admin/users?id=...  — delete a user (cannot delete self or last admin)
 */

export async function GET() {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const users = await db.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: {
        select: {
          watchlist: true,
          progress: true,
        },
      },
    },
  });

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      name: u.name,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt,
      watchlistCount: u._count.watchlist,
      progressCount: u._count.progress,
    }))
  );
}

export async function DELETE(req: NextRequest) {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const url = new URL(req.url);
  const targetId = url.searchParams.get("id");
  if (!targetId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  if (targetId === admin.id) {
    return NextResponse.json({ error: "You can't delete yourself" }, { status: 400 });
  }

  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (target.isAdmin) {
    const adminCount = await db.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) {
      return NextResponse.json({ error: "Can't delete the last admin" }, { status: 400 });
    }
  }

  // Cascading delete will wipe watchlist + progress automatically
  await db.user.delete({ where: { id: targetId } });
  return NextResponse.json({ ok: true });
}