import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  clearRealDebridToken,
  fetchRealDebridAccount,
  getRealDebridStatus,
  saveRealDebridToken,
} from "@/lib/debrid-credentials";

/**
 * Real-Debrid "Premium" subscription — status + token management.
 * Admin only. The token is never returned in any response body.
 *
 * GET    /api/debrid/status   — current subscription status (from the effective token)
 * POST   /api/debrid/status   — { token } → validate against RD, then persist + activate
 * DELETE /api/debrid/status   — remove the DB token override (reverts to the .env token)
 */

export const dynamic = "force-dynamic";

/** Looks plausible as an RD API token before we spend a network round-trip validating it. */
const TOKEN_SHAPE = /^[A-Za-z0-9]{20,100}$/;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const status = await getRealDebridStatus();
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
  if (!token) return NextResponse.json({ error: "Token is required." }, { status: 400 });
  if (!TOKEN_SHAPE.test(token)) {
    return NextResponse.json(
      { error: "That does not look like a Real-Debrid API token." },
      { status: 400 }
    );
  }

  // Validate before persisting so a bad token is never stored or activated.
  const { ok, status } = await fetchRealDebridAccount(token);
  if (!ok) {
    const error =
      status === 401
        ? "Real-Debrid rejected this token (invalid or expired)."
        : status === 0
          ? "Could not reach Real-Debrid to verify the token."
          : `Real-Debrid returned HTTP ${status}.`;
    return NextResponse.json({ error }, { status: 400 });
  }

  await saveRealDebridToken(token);
  const result = await getRealDebridStatus();
  return NextResponse.json(result, { headers: NO_STORE });
}

export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  await clearRealDebridToken();
  const status = await getRealDebridStatus();
  return NextResponse.json(status, { headers: NO_STORE });
}
