/**
 * AllDebrid credential helpers — same contract as Real-Debrid:
 *   1. AppSetting `alldebrid_token` (Settings UI) is source of truth.
 *   2. `process.env.ALLDEBRID_API_KEY` (or ALLDEBRID_API_TOKEN) is the
 *      boot-time fallback.
 *
 * The debrid roster reads ONLY `process.env.ALLDEBRID_API_KEY`. This module
 * mirrors the effective key into that env var at boot and after every save.
 * The raw key is never returned to a client and never logged.
 */
import { db } from "@/lib/db";
import { clearRosterCache } from "@/lib/playback/resolve-full";

export const ALLDEBRID_TOKEN_KEY = "alldebrid_token";
export const ALLDEBRID_ENV_KEY = "ALLDEBRID_API_KEY";

const AD_USER_ENDPOINT = "https://api.alldebrid.com/v4/user";
const AD_AGENT = "CineHome";
const AD_TIMEOUT_MS = 8_000;

const ENV_TOKEN_AT_BOOT: string =
  process.env.ALLDEBRID_API_KEY?.trim() ||
  process.env.ALLDEBRID_API_TOKEN?.trim() ||
  "";

export type AllDebridTokenSource = "database" | "env" | "none";

export interface AllDebridStatus {
  configured: boolean;
  source: AllDebridTokenSource;
  valid: boolean;
  premium: boolean;
  username: string | null;
  expiresAt: string | null;
  points: number | null;
  accountType: string | null;
  error: string | null;
}

interface AdUserPayload {
  status?: string;
  data?: {
    user?: {
      username?: string;
      isPremium?: boolean;
      premiumUntil?: number;
      fidelityPoints?: number;
    };
  };
  error?: { message?: string };
}

export async function getEffectiveAllDebridToken(): Promise<{
  token: string | null;
  source: AllDebridTokenSource;
}> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: ALLDEBRID_TOKEN_KEY } });
    const dbToken = row?.value?.trim();
    if (dbToken) return { token: dbToken, source: "database" };
  } catch {
    /* DB unavailable — fall back to env */
  }
  if (ENV_TOKEN_AT_BOOT) return { token: ENV_TOKEN_AT_BOOT, source: "env" };
  return { token: null, source: "none" };
}

export async function syncAllDebridTokenToEnv(): Promise<AllDebridTokenSource> {
  const { token, source } = await getEffectiveAllDebridToken();
  process.env.ALLDEBRID_API_KEY = token ?? "";
  return source;
}

export async function fetchAllDebridAccount(
  token: string
): Promise<{ ok: boolean; status: number; data: AdUserPayload["data"] | null }> {
  try {
    const url = `${AD_USER_ENDPOINT}?agent=${encodeURIComponent(AD_AGENT)}&apikey=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(AD_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const body = (await res.json()) as AdUserPayload;
    if (body.status !== "success" || !body.data?.user) {
      return { ok: false, status: 401, data: null };
    }
    return { ok: true, status: res.status, data: body.data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function describeAdError(status: number): string {
  if (status === 401) return "AllDebrid rejected this API key (invalid or expired).";
  if (status === 0) return "Could not reach AllDebrid.";
  return `AllDebrid returned HTTP ${status}.`;
}

export async function getAllDebridStatus(): Promise<AllDebridStatus> {
  const { token, source } = await getEffectiveAllDebridToken();
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

  const { ok, status, data } = await fetchAllDebridAccount(token);
  const user = data?.user;
  if (!ok || !user) {
    return {
      configured: true,
      source,
      valid: false,
      premium: false,
      username: null,
      expiresAt: null,
      points: null,
      accountType: null,
      error: describeAdError(status),
    };
  }

  const until = typeof user.premiumUntil === "number" ? user.premiumUntil * 1000 : 0;
  const expiresAt = until > 0 ? new Date(until).toISOString() : null;
  const notExpired = until > 0 ? until > Date.now() : Boolean(user.isPremium);
  return {
    configured: true,
    source,
    valid: true,
    premium: Boolean(user.isPremium) && notExpired,
    username: user.username ?? null,
    expiresAt,
    points: typeof user.fidelityPoints === "number" ? user.fidelityPoints : null,
    accountType: user.isPremium ? "premium" : "free",
    error: null,
  };
}

export async function saveAllDebridToken(token: string): Promise<void> {
  await db.appSetting.upsert({
    where: { key: ALLDEBRID_TOKEN_KEY },
    update: { value: token },
    create: { key: ALLDEBRID_TOKEN_KEY, value: token },
  });
  process.env.ALLDEBRID_API_KEY = token;
  clearRosterCache();
}

export async function clearAllDebridToken(): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: ALLDEBRID_TOKEN_KEY } });
  process.env.ALLDEBRID_API_KEY = ENV_TOKEN_AT_BOOT;
  clearRosterCache();
}
