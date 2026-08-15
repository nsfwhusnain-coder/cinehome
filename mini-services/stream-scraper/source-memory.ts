/**
 * Disk memory for "this title already had Quasar 4K / Luna 1080".
 *
 * In-process scrape cache is wiped on every container restart, so the next
 * play re-scrapes from zero. This folder survives deploys:
 *   data/source-memory/catalog/  — which servers had the title, and at what height
 *   data/source-memory/rosters/  — warm scrape payloads until signed URLs expire
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CATALOG_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const EMPTY_SKIP_MS = 18 * 60 * 60 * 1000;
/** Disk roster outlives signed HLS URLs. A 410 refresh is cheaper than a full scrape. */
export const DISK_ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_CATALOG_FILES = 800;
export const MAX_ROSTER_FILES = 240;

export interface MemoryServer {
  provider: string;
  label: string;
  maxHeight: number;
  lastOkAt: number;
  lastEmptyAt?: number;
}

export interface TitleCatalog {
  id: string;
  updatedAt: number;
  servers: MemoryServer[];
}

export interface WarmRoster<T> {
  key: string;
  expiresAt: number;
  result: T;
}

function memoryRoot(): string {
  const fromEnv = process.env.SOURCE_MEMORY_DIR?.trim();
  if (fromEnv) return fromEnv;
  // start.sh cds into mini-services/stream-scraper. The bind mount is /app/data.
  if (existsSync("/app/data")) return "/app/data/source-memory";
  return join(process.cwd(), "data", "source-memory");
}

export function rosterIdentity(titleOrCacheKey: string): string {
  return titleMemoryIdFromCacheKey(titleOrCacheKey) ?? titleOrCacheKey;
}

function catalogDir(): string {
  return join(memoryRoot(), "catalog");
}

function rosterDir(): string {
  return join(memoryRoot(), "rosters");
}

export function titleMemoryId(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number
): string {
  if (mediaType === "tv") {
    return `tv-${tmdbId}-s${season ?? 1}e${episode ?? 1}`;
  }
  return `movie-${tmdbId}`;
}

export function titleMemoryIdFromCacheKey(key: string): string | null {
  const parts = key.split(":");
  const mediaType = parts[0];
  const tmdbId = Number(parts[1]);
  if ((mediaType !== "movie" && mediaType !== "tv") || !Number.isFinite(tmdbId)) {
    return null;
  }
  if (mediaType === "tv") {
    return titleMemoryId("tv", tmdbId, Number(parts[2]) || 1, Number(parts[3]) || 1);
  }
  return titleMemoryId("movie", tmdbId);
}

export function safeMemoryName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, JSON.stringify(value));
}

function pruneOldest(dir: string, maxFiles: number): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
  const extra = files.length - maxFiles;
  if (extra <= 0) return;
  for (const file of files.slice(0, extra)) {
    try {
      unlinkSync(file.path);
    } catch {
      /* ignore */
    }
  }
}

export function catalogPath(id: string): string {
  return join(catalogDir(), `${safeMemoryName(id)}.json`);
}

export function rosterPath(cacheKey: string): string {
  return join(rosterDir(), `${safeMemoryName(cacheKey)}.json`);
}

export function readTitleCatalog(id: string): TitleCatalog | null {
  const parsed = readJson<TitleCatalog>(catalogPath(id));
  if (!parsed?.id || !Array.isArray(parsed.servers)) return null;
  if (Date.now() - parsed.updatedAt > CATALOG_TTL_MS) return null;
  return parsed;
}

export function rememberTitleHits(
  id: string,
  sources: ReadonlyArray<{ provider: string; label: string; maxHeight?: number }>,
  now = Date.now()
): TitleCatalog {
  const current = readTitleCatalog(id) ?? { id, updatedAt: now, servers: [] };
  const byKey = new Map(
    current.servers.map((server) => [`${server.provider}\0${server.label}`, server])
  );
  for (const source of sources) {
    const key = `${source.provider}\0${source.label}`;
    const height = source.maxHeight && source.maxHeight > 0 ? source.maxHeight : 0;
    const prev = byKey.get(key);
    byKey.set(key, {
      provider: source.provider,
      label: source.label,
      maxHeight: Math.max(prev?.maxHeight ?? 0, height),
      lastOkAt: now,
      ...(prev?.lastEmptyAt != null ? { lastEmptyAt: prev.lastEmptyAt } : {}),
    });
  }
  const next: TitleCatalog = {
    id,
    updatedAt: now,
    servers: [...byKey.values()],
  };
  writeJson(catalogPath(id), next);
  pruneOldest(catalogDir(), MAX_CATALOG_FILES);
  return next;
}

export function rememberTitleMiss(
  id: string,
  provider: string,
  now = Date.now()
): TitleCatalog {
  const current = readTitleCatalog(id) ?? { id, updatedAt: now, servers: [] };
  const existing = current.servers.find((server) => server.provider === provider);
  if (existing) {
    existing.lastEmptyAt = now;
  } else {
    current.servers.push({
      provider,
      label: provider,
      maxHeight: 0,
      lastOkAt: 0,
      lastEmptyAt: now,
    });
  }
  current.updatedAt = now;
  writeJson(catalogPath(id), current);
  pruneOldest(catalogDir(), MAX_CATALOG_FILES);
  return current;
}

export function catalogHasFourK(catalog: TitleCatalog | null): boolean {
  return Boolean(catalog?.servers.some((server) => server.maxHeight >= 2160));
}

export function providersToSkip(
  catalog: TitleCatalog | null,
  now = Date.now()
): string[] {
  if (!catalog) return [];
  return catalog.servers
    .filter((server) => {
      if (!server.lastEmptyAt) return false;
      if (server.lastOkAt >= server.lastEmptyAt) return false;
      return now - server.lastEmptyAt < EMPTY_SKIP_MS;
    })
    .map((server) => server.provider);
}

export function persistWarmRoster<T>(
  titleOrCacheKey: string,
  result: T,
  expiresAt: number
): void {
  if (expiresAt <= Date.now()) return;
  const titleId = rosterIdentity(titleOrCacheKey);
  writeJson(rosterPath(titleId), { key: titleId, expiresAt, result });
  pruneOldest(rosterDir(), MAX_ROSTER_FILES);
}

export function loadWarmRoster<T>(titleOrCacheKey: string): WarmRoster<T> | null {
  const titleId = rosterIdentity(titleOrCacheKey);
  const parsed = readJson<WarmRoster<T>>(rosterPath(titleId));
  if (!parsed?.key || typeof parsed.expiresAt !== "number") return null;
  if (parsed.expiresAt <= Date.now()) {
    try {
      unlinkSync(rosterPath(titleId));
    } catch {
      /* ignore */
    }
    return null;
  }
  return parsed;
}

export function hydrateWarmRosters<T>(): WarmRoster<T>[] {
  const dir = rosterDir();
  if (!existsSync(dir)) return [];
  pruneOldest(dir, MAX_ROSTER_FILES);
  const warm: WarmRoster<T>[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const parsed = readJson<WarmRoster<T>>(join(dir, name));
    if (!parsed?.key || parsed.expiresAt <= Date.now()) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* ignore */
      }
      continue;
    }
    warm.push(parsed);
  }
  return warm;
}
