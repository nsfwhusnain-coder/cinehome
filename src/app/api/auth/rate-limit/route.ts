import { NextRequest, NextResponse } from "next/server";
import {
  checkAuthRateLimit,
  clientIpFromHeaders,
} from "@/lib/login-rate-limit";

/**
 * POST /api/auth/rate-limit
 * Body: { name: string }
 *
 * Returns whether the given username is currently locked out.
 * Used by the login UI after a failed sign-in to show a clear message
 * (NextAuth does not surface custom authorize error strings to the client).
 * Does not reveal whether the user account exists.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name?: string };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ allowed: true });
    }

    const ip = clientIpFromHeaders(req.headers);
    const result = checkAuthRateLimit(name, ip);

    if (!result.allowed) {
      return NextResponse.json(
        {
          allowed: false,
          message: result.message,
          retryAfterMs: result.retryAfterMs,
        },
        { status: 429 }
      );
    }

    return NextResponse.json({ allowed: true });
  } catch {
    return NextResponse.json({ allowed: true });
  }
}
