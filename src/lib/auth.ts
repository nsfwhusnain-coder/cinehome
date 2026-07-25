import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  checkAuthRateLimit,
  clearAuthFailures,
  recordAuthFailure,
} from "@/lib/login-rate-limit";

function ipFromAuthorizeReq(req: { headers?: Headers | Record<string, string | string[] | undefined> } | undefined): string | null {
  if (!req?.headers) return null;
  const headers = req.headers;
  if (typeof (headers as Headers).get === "function") {
    const h = headers as Headers;
    return h.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? h.get("x-real-ip")
      ?? null;
  }
  const plain = headers as Record<string, string | string[] | undefined>;
  const forwarded = plain["x-forwarded-for"] ?? plain["X-Forwarded-For"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) return value.split(",")[0]?.trim() ?? null;
  const real = plain["x-real-ip"] ?? plain["X-Real-Ip"];
  return (Array.isArray(real) ? real[0] : real) ?? null;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        name: { label: "Name", type: "text" },
        pin: { label: "PIN", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.name || !credentials?.pin) return null;

        const name = credentials.name.trim();
        const ip = ipFromAuthorizeReq(req);

        // KD21: per-username lockout (soft IP secondary inside check)
        const limit = checkAuthRateLimit(name, ip);
        if (!limit.allowed) {
          // Fail closed without revealing whether the user exists.
          return null;
        }

        const user = await db.user.findUnique({ where: { name } });
        if (!user) {
          recordAuthFailure(name, ip);
          return null;
        }
        const ok = await bcrypt.compare(credentials.pin, user.pinHash);
        if (!ok) {
          recordAuthFailure(name, ip);
          return null;
        }

        clearAuthFailures(name, ip);
        return {
          id: user.id,
          name: user.name,
          isAdmin: user.isAdmin,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isAdmin = user.isAdmin;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id) {
        session.user.id = token.id as string;
        session.user.isAdmin = token.isAdmin as boolean;
        if (token.name) session.user.name = token.name as string;
      }
      return session;
    },
  },
  // NextAuth v4 types omit trustHost; runtime + AUTH_TRUST_HOST support multi-host access.
  ...({ trustHost: true } as object),
};

export interface AuthenticatedUser {
  id: string;
  isAdmin: boolean;
  name: string;
}

/**
 * Short-lived memo for the user-existence DB check (KD-perf: the manifest AND every
 * segment request call getAuthenticatedUser, contending with the /api/progress writer
 * on the same SQLite file). The JWT itself is still verified on every call via
 * getServerSession — this only avoids re-querying the DB for a user we just confirmed
 * exists. Kept short so a deleted account loses access within one TTL window.
 */
const USER_MEMO_TTL_MS = 60_000;
const userMemoCache = new Map<string, { user: AuthenticatedUser; expiresAt: number }>();

/** Resolves the signed-in user when the account still exists in the database (fresh isAdmin/name from DB). */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return null;

  const cached = userMemoCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, isAdmin: true, name: true },
  });
  if (!user) {
    userMemoCache.delete(userId);
    return null;
  }

  const authenticated: AuthenticatedUser = { id: user.id, isAdmin: user.isAdmin, name: user.name };
  userMemoCache.set(userId, { user: authenticated, expiresAt: Date.now() + USER_MEMO_TTL_MS });
  return authenticated;
}

/** Resolves the signed-in user id only when the account still exists in the database. */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const user = await getAuthenticatedUser();
  return user?.id ?? null;
}
