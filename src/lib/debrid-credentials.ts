/**
 * Real-Debrid credential + subscription helpers for the Settings "Premium"
 * panel.
 *
 * The owner's Real-Debrid API token can live in two places:
 *   1. The `AppSetting` table (key `realdebrid_token`) — set from the Settings
 *      UI, the SOURCE OF TRUTH once present. Survives container restarts.
 *   2. `process.env.REAL_DEBRID_API_TOKEN` (or the `REALDEBRID_TOKEN` alias) —
 *      the initial `.env` value, used as a fallback when the DB has none.
 *
 * The debrid tier (src/lib/playback/debrid/*) reads the token ONLY from
 * `process.env.REAL_DEBRID_API_TOKEN`. To make the DB value authoritative
 * without touching that tier, `syncRealDebridTokenToEnv()` mirrors the
 * effective token into `process.env` at boot (see src/instrumentation.ts) and
 * after every save/clear.
 *
 * The token is NEVER returned to any client and NEVER logged. `getRealDebridStatus`
 * exposes only account metadata (username, expiry, points, type).
 */
import { db } from "@/lib/db";
import { clearRosterCache } from "@/lib/playback/resolve-full";

/** AppSetting key under which the owner's Real-Debrid token is persisted.
 *  SECRET — GET /api/settings must never serialize this key (see that route). */
export const REALDEBRID_TOKEN_KEY = "realdebrid_token";

const RD_USER_ENDPOINT = "https://api.real-debrid.com/rest/1.0/user";
const RD_TIMEOUT_MS = 8_000;

/**
 * The `.env` token captured once, at module load, BEFORE any code mutates
 * `process.env.REAL_DEBRID_API_TOKEN`. Used as the env fallback so that after a
 * DB override is applied (which overwrites the live env var) we can still tell
 * where the effective token really came from and revert cleanly on clear.
 */
const ENV_TOKEN_AT_BOOT: string =
  process.env.REAL_DEBRID_API_TOKEN?.trim() || process.env.REALDEBRID_TOKEN?.trim() || "";

export type RealDebridTokenSource = "database" | "env" | "none";

export interface RealDebridStatus {
  /** A token is configured (from DB or env). Does not imply it is valid. */
  configured: boolean;
  /** Where the effective token comes from. */
  source: RealDebridTokenSource;
  /** Real-Debrid accepted the token (HTTP 200 on /user). */
  valid: boolean;
  /** Premium account and not expired. */
  premium: boolean;
  username: string | null;
  /** ISO 8601 expiry timestamp, or null. */
  expiresAt: string | null;
  /** Loyalty points, or null. */
  points: number | null;
  /** Account type reported by Real-Debrid ("premium" | "free"), or null. */
  accountType: string | null;
  /** Human-readable problem when `valid` is false; null otherwise. */
  error: string | null;
}

interface RdUser {
  username?: string;
  type?: string;
  premium?: number;
  points?: number;
  expiration?: string;
}

/** Effective token: DB override first, then the boot-time `.env` value. Never logged. */
export async function getEffectiveRealDebridToken(): Promise<{
  token: string | null;
  source: RealDebridTokenSource;
}> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: REALDEBRID_TOKEN_KEY } });
    const dbToken = row?.value?.trim();
    if (dbToken) return { token: dbToken, source: "database" };
  } catch {
    // DB unavailable — fall back to env rather than throw.
  }
  if (ENV_TOKEN_AT_BOOT) return { token: ENV_TOKEN_AT_BOOT, source: "env" };
  return { token: null, source: "none" };
}

/**
 * Mirror the effective token into `process.env.REAL_DEBRID_API_TOKEN` so the
 * unmodified debrid tier picks up a DB override. Returns the source it applied.
 * Never logs the token value.
 */
export async function syncRealDebridTokenToEnv(): Promise<RealDebridTokenSource> {
  const { token, source } = await getEffectiveRealDebridToken();
  process.env.REAL_DEBRID_API_TOKEN = token ?? "";
  return source;
}

/** Validate a token against Real-Debrid's /user endpoint. Never logs the token. */
export async function fetchRealDebridAccount(
  token: string
): Promise<{ ok: boolean; status: number; data: RdUser | null }> {
  try {
    const res = await fetch(RD_USER_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(RD_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: (await res.json()) as RdUser };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function describeRdError(status: number): string {
  if (status === 401) return "Real-Debrid rejected this token (invalid or expired).";
  if (status === 0) return "Could not reach Real-Debrid.";
  return `Real-Debrid returned HTTP ${status}.`;
}

/** Current subscription status for the Settings panel. NEVER returns the token. */
export async function getRealDebridStatus(): Promise<RealDebridStatus> {
  const { token, source } = await getEffectiveRealDebridToken();
  if (!token) {
    return {
      configured: false,
      source: "none",
      valid: false,
      premium: false,
      username: null,
      expiresAt: null,
      points: null,
      accountType: null,
      error: null,
    };
  }

  const { ok, status, data } = await fetchRealDebridAccount(token);
  if (!ok || !data) {
    return {
      configured: true,
      source,
      valid: false,
      premium: false,
      username: null,
      expiresAt: null,
      points: null,
      accountType: null,
      error: describeRdError(status),
    };
  }

  const expiresAt = data.expiration ?? null;
  const notExpired = expiresAt ? Date.parse(expiresAt) > Date.now() : true;
  const hasTime = typeof data.premium === "number" ? data.premium > 0 : true;
  return {
    configured: true,
    source,
    valid: true,
    premium: data.type === "premium" && hasTime && notExpired,
    username: data.username ?? null,
    expiresAt,
    points: typeof data.points === "number" ? data.points : null,
    accountType: data.type ?? null,
    error: null,
  };
}

/** Persist a token (the caller must have validated it) and activate it live. */
export async function saveRealDebridToken(token: string): Promise<void> {
  await db.appSetting.upsert({
    where: { key: REALDEBRID_TOKEN_KEY },
    update: { value: token },
    create: { key: REALDEBRID_TOKEN_KEY, value: token },
  });
  process.env.REAL_DEBRID_API_TOKEN = token;
  clearRosterCache();
}

/** Remove the DB override; the effective token reverts to the boot-time `.env` value (if any). */
export async function clearRealDebridToken(): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: REALDEBRID_TOKEN_KEY } });
  process.env.REAL_DEBRID_API_TOKEN = ENV_TOKEN_AT_BOOT;
  clearRosterCache();
}
