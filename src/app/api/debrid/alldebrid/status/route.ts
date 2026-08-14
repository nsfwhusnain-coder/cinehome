import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  clearAllDebridToken,
  fetchAllDebridAccount,
  getAllDebridStatus,
  saveAllDebridToken,
} from "@/lib/alldebrid-credentials";

/**
 * AllDebrid key management. Admin only. The key never leaves the server.
 *
 * GET    — current status (from the effective key)
 * POST   — { token } → validate, persist, activate live env
 * DELETE — remove the DB override (reverts to boot-time .env if any)
 */

export const dynamic = "force-dynamic";

const TOKEN_SHAPE = /^[A-Za-z0-9]{12,128}$/;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const status = await getAllDebridStatus();
  return NextResponse.json(status, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "API key is required." }, { status: 400 });
  if (!TOKEN_SHAPE.test(token)) {
    return NextResponse.json(
      { error: "That does not look like an AllDebrid API key." },
      { status: 400 }
    );
  }

  const { ok, status } = await fetchAllDebridAccount(token);
  if (!ok) {
    const error =
      status === 401
        ? "AllDebrid rejected this API key (invalid or expired)."
        : status === 0
          ? "Could not reach AllDebrid to verify the key."
          : `AllDebrid returned HTTP ${status}.`;
    return NextResponse.json({ error }, { status: 400 });
  }

  await saveAllDebridToken(token);
  const result = await getAllDebridStatus();
  return NextResponse.json(result, { headers: NO_STORE });
}

export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  await clearAllDebridToken();
  const status = await getAllDebridStatus();
  return NextResponse.json(status, { headers: NO_STORE });
}
