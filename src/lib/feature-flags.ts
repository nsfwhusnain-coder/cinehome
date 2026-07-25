import { db } from "@/lib/db";

const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/** UI / playback flags stored as AppSetting key → "on" | "off". */
export const FLAG_DEFAULTS: Record<string, string> = {
  flag_ui_bottom_nav: "on",
  flag_ui_hubs: "on",
  flag_playback_fast_path: "on",
};

/**
 * Read an AppSetting flag with a short in-memory cache (30s).
 * Missing rows return `defaultValue` so flags default ON without a seed.
 */
export async function getAppFlag(key: string, defaultValue: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    const row = await db.appSetting.findUnique({ where: { key } });
    const value = row?.value ?? defaultValue;
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch {
    return defaultValue;
  }
}

/** Invalidate after admin writes so the next read is fresh. */
export function invalidateAppFlag(key: string): void {
  cache.delete(key);
}

function isOn(value: string): boolean {
  return value !== "off" && value !== "0" && value !== "false";
}

/** Mobile bottom dock — default ON (KD9 / PR-06). */
export async function isBottomNavEnabled(): Promise<boolean> {
  const value = await getAppFlag("flag_ui_bottom_nav", FLAG_DEFAULTS.flag_ui_bottom_nav);
  return isOn(value);
}

/** Movies/Shows hub routes in primary nav — default ON (PR-07). */
export async function isHubsEnabled(): Promise<boolean> {
  const value = await getAppFlag("flag_ui_hubs", FLAG_DEFAULTS.flag_ui_hubs);
  return isOn(value);
}

/**
 * Playback fast path (`fast=1` / prefetch). When off, the playback route
 * ignores client fast flags and always does a full resolve.
 */
export async function isPlaybackFastPathEnabled(): Promise<boolean> {
  const value = await getAppFlag(
    "flag_playback_fast_path",
    FLAG_DEFAULTS.flag_playback_fast_path
  );
  return isOn(value);
}
