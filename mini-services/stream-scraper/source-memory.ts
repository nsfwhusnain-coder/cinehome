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
export const ROSTER_BUCKET_HD = "q1080";
export const ROSTER_BUCKET_UHD = "q2160";
export const ROSTER_UHD_MIN_HEIGHT = 2160;
const CACHE_KEY_QUALITY_RE = /(?:^|:)q(\d+)(?:$|:)/i;
const ROSTER_IDENTITY_QUALITY_RE = /:q\d+$/i;

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

export function qualityBucketFromHeight(height: number): string {
  return Number.isFinite(height) && height >= ROSTER_UHD_MIN_HEIGHT
    ? ROSTER_BUCKET_UHD
    : ROSTER_BUCKET_HD;
}

/** Parse `qNNNN` from a cache key. Missing / auto / below 2160 → q1080. */
export function qualityBucketFromCacheKey(key: string): string {
  const match = CACHE_KEY_QUALITY_RE.exec(key);
  if (!match?.[1]) return ROSTER_BUCKET_HD;
  return qualityBucketFromHeight(Number(match[1]));
}

/**
 * Disk roster identity: title + quality bucket.
 * Fast/full share a file; 1080 and 2160 do not.
 */
export function rosterIdentity(titleOrCacheKey: string): string {
  const titleId =
    titleMemoryIdFromCacheKey(titleOrCacheKey) ??
    titleOrCacheKey.replace(ROSTER_IDENTITY_QUALITY_RE, "");
  const bucket = qualityBucketFromCacheKey(titleOrCacheKey);
  return `${titleId}:${bucket}`;
}

/** RAM sibling reuse: never serve q1080 as a 4K hit. UHD may satisfy HD. */
export function rosterSatisfiesQuality(storedKey: string, requestKey: string): boolean {
  const stored = qualityBucketFromCacheKey(storedKey);
  const want = qualityBucketFromCacheKey(requestKey);
  if (stored === want) return true;
  return stored === ROSTER_BUCKET_UHD && want === ROSTER_BUCKET_HD;
}

export function cachedEntryTitleId(keyOrIdentity: string): string | null {
  const fromCache = titleMemoryIdFromCacheKey(keyOrIdentity);
  if (fromCache) return fromCache;
  const stripped = keyOrIdentity.replace(ROSTER_IDENTITY_QUALITY_RE, "");
  return stripped.startsWith("movie-") || stripped.startsWith("tv-") ? stripped : null;
}

function catalogDir(): string {
  return join(memoryRoot(), "catalog");
}

function rosterDir(): string {
  return join(memoryRoot(), "rosters");
}

/** Season 0 is TMDB specials — truthiness used to collapse it to S1. */
export function tvMemoryIndex(value?: number | null): number {
  return value != null && Number.isFinite(value) && value >= 0 ? value : 1;
}

function tvIndexFromCachePart(raw: string | undefined): number {
  if (raw == null || raw === "") return 1;
  return tvMemoryIndex(Number(raw));
}

export function titleMemoryId(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number
): string {
  if (mediaType === "tv") {
    return `tv-${tmdbId}-s${tvMemoryIndex(season)}e${tvMemoryIndex(episode)}`;
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
    return titleMemoryId(
      "tv",
      tmdbId,
      tvIndexFromCachePart(parts[2]),
      tvIndexFromCachePart(parts[3])
    );
  }
  return titleMemoryId("movie", tmdbId);
}

export function showMemoryId(tmdbId: number): string {
  return `tv-${tmdbId}`;
}

export function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

interface FoldedProvider {
  ok: number;
  empty: number;
  maxHeight: number;
}

function foldServers(servers: readonly MemoryServer[]): Map<string, FoldedProvider> {
  const folded = new Map<string, FoldedProvider>();
  for (const server of servers) {
    const id = normalizeProviderId(server.provider);
    const current = folded.get(id) ?? { ok: 0, empty: 0, maxHeight: 0 };
    current.ok = Math.max(current.ok, server.lastOkAt);
    current.empty = Math.max(current.empty, server.lastEmptyAt ?? 0);
    current.maxHeight = Math.max(current.maxHeight, server.maxHeight);
    folded.set(id, current);
  }
  return folded;
}

export function knownGoodProviders(catalog: TitleCatalog | null): string[] {
  if (!catalog) return [];
  return [...foldServers(catalog.servers).entries()]
    .filter(([, server]) => server.ok > 0 && server.ok >= server.empty)
    .map(([id]) => id);
}

function knownGoodWithHeight(
  catalog: TitleCatalog | null
): Array<{ id: string; maxHeight: number }> {
  if (!catalog) return [];
  return [...foldServers(catalog.servers).entries()]
    .filter(([, server]) => server.ok > 0 && server.ok >= server.empty)
    .map(([id, server]) => ({ id, maxHeight: server.maxHeight }));
}

export function preferredProvidersForTitle(
  episodeCatalog: TitleCatalog | null,
  showCatalog: TitleCatalog | null = null
): string[] {
  const merged = new Map<string, number>();
  for (const row of [
    ...knownGoodWithHeight(episodeCatalog),
    ...knownGoodWithHeight(showCatalog),
  ]) {
    merged.set(row.id, Math.max(merged.get(row.id) ?? 0, row.maxHeight));
  }
  return [...merged.entries()]
    .sort((a, b) => {
      const aUhd = a[1] >= ROSTER_UHD_MIN_HEIGHT ? 1 : 0;
      const bUhd = b[1] >= ROSTER_UHD_MIN_HEIGHT ? 1 : 0;
      return bUhd - aUhd;
    })
    .map(([id]) => id);
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
    current.servers.map((server) => [
      `${normalizeProviderId(server.provider)}\0${server.label.trim().toLowerCase()}`,
      server,
    ])
  );
  const hitProviders = new Set<string>();
  for (const source of sources) {
    const providerId = normalizeProviderId(source.provider);
    if (!providerId) continue;
    hitProviders.add(providerId);
    const key = `${providerId}\0${source.label.trim().toLowerCase()}`;
    const height = source.maxHeight && source.maxHeight > 0 ? source.maxHeight : 0;
    const prev = byKey.get(key);
    byKey.set(key, {
      provider: providerId,
      label: source.label.trim() || providerId,
      maxHeight: Math.max(prev?.maxHeight ?? 0, height),
      lastOkAt: now,
    });
  }
  for (const [key, server] of [...byKey.entries()]) {
    if (!hitProviders.has(normalizeProviderId(server.provider))) continue;
    if (server.lastOkAt >= now) {
      if (server.lastEmptyAt != null) {
        byKey.set(key, { ...server, lastEmptyAt: undefined });
      }
      continue;
    }
    byKey.delete(key);
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
  const providerId = normalizeProviderId(provider);
  const current = readTitleCatalog(id) ?? { id, updatedAt: now, servers: [] };
  const folded = foldServers(current.servers).get(providerId);
  if (folded && folded.ok >= folded.empty && folded.ok > 0) {
    return current;
  }
  const existing = current.servers.find(
    (server) => normalizeProviderId(server.provider) === providerId
  );
  if (existing) {
    existing.lastEmptyAt = now;
    existing.provider = providerId;
  } else {
    current.servers.push({
      provider: providerId,
      label: providerId,
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
  related: TitleCatalog | null = null,
  now = Date.now()
): string[] {
  const protectedProviders = new Set([
    ...knownGoodProviders(catalog),
    ...knownGoodProviders(related),
  ]);
  if (!catalog) return [];
  return [...foldServers(catalog.servers).entries()]
    .filter(([id, server]) => {
      if (protectedProviders.has(id)) return false;
      if (!server.empty) return false;
      if (server.ok >= server.empty) return false;
      return now - server.empty < EMPTY_SKIP_MS;
    })
    .map(([id]) => id);
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

export function backfillShowCatalogs(now = Date.now()): number {
  const dir = catalogDir();
  if (!existsSync(dir)) return 0;
  const shows = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const parsed = readJson<TitleCatalog>(join(dir, name));
    if (!parsed?.id || !Array.isArray(parsed.servers)) continue;
    const match = /^tv-(\d+)-s\d+e\d+$/.exec(parsed.id);
    if (!match) continue;
    const hits = parsed.servers.filter(
      (server) => server.lastOkAt > 0 && server.lastOkAt >= (server.lastEmptyAt ?? 0)
    );
    if (!hits.length) continue;
    const showId = showMemoryId(Number(match[1]));
    rememberTitleHits(
      showId,
      hits.map((server) => ({
        provider: server.provider,
        label: server.label,
        maxHeight: server.maxHeight,
      })),
      now
    );
    shows.add(showId);
  }
  return shows.size;
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
