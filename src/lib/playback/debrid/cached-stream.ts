/**
 * Typed read/write helper for the `CachedStream` table (prisma/schema.prisma)
 * — avoids re-running the Torrentio + Real-Debrid add/select/poll/unrestrict
 * (or TorBox add/poll/requestdl) flow on every repeat view of the same
 * title/quality.
 *
 * Keyed by (imdbId, mediaType, season, episode, quality, provider) — the
 * `provider` column keeps Real-Debrid and TorBox resolves for the same
 * title/quality fully independent (see prisma/schema.prisma). Direct links
 * can die before `expiresAt` (both RD and TorBox rotate/expire CDN links on
 * their own schedule) — callers MUST treat a stale row (past `expiresAt`) as
 * a cache miss and re-resolve; this module only enforces the TTL on read, it
 * does not attempt to detect a dead link (the player owns playback, not this
 * tier — a 404/410 during actual playback can only be caught by re-resolving
 * on the next request once expired).
 *
 * The `quality` column (`prisma/schema.prisma` — plain `String`, no DB-level
 * enum, so widening its value set below needs no migration) historically
 * only ever held `DebridQuality` ("2160p"/"1080p") — TorBox still uses
 * exactly that, one row per height. Real-Debrid now caches a richer,
 * multi-source roster (see index.ts: best native, several native 1080p,
 * best Safari-4K) and needs more than one row per height, so its rows are
 * keyed by `DebridSlot` instead — a slot identity, not a literal resolution
 * string. Both value sets share this same column/type; callers just pick
 * whichever fits their provider.
 */
import { db } from "@/lib/db";
import type { MediaType } from "../types";
import { storedQualityForCache } from "./cache-policy";
import type { ReleaseCompat } from "./torrentio";

/** TorBox's cache identity — unchanged, one row per height. */
export type DebridQuality = "2160p" | "1080p";
/**
 * Real-Debrid's cache identity — one row per roster slot rather than per
 * height, so several distinct sources can be cached (and surfaced) at once.
 * "native-2160" / "native-1080-1" are candidates for the auto-default (best
 * native, whichever height is actually available); "native-1080-2"/"-3" are
 * the additional native 1080p roster entries; "safari-2160" is the best
 * HEVC/MP4 4K pick, tagged `compat: "safari"` on the resulting source; and
 * "native-720" is used only when no higher native source is available.
 */
export type DebridSlot =
  | "native-2160"
  | "safari-2160"
  | "native-1080-1"
  | "native-1080-2"
  | "native-1080-3"
  | "native-720";
/** "realdebrid" is the original/default tier; "torbox" is the new sibling. */
export type DebridProvider = "realdebrid" | "torbox" | "alldebrid";

/** RD/TorBox direct links are usually good well under this, but expire eventually — re-resolve past this point. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedStreamKey {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  /** A `DebridQuality` for TorBox rows, a `DebridSlot` for Real-Debrid rows — see the module header. */
  quality: DebridQuality | DebridSlot;
  provider: DebridProvider;
}

export interface CachedStreamRecord {
  /** Release title parsed from the Torrentio stream — kept for diagnostics/labels. */
  title: string;
  /** infoHash (path b) or the original RD/Torrentio link this was resolved from. */
  source: string;
  /** Resolved direct-playable link (Real-Debrid unrestrict `download`). */
  url: string;
  compat: ReleaseCompat;
  /** Parsed release codec — restored on cache read so debrid sources keep it after the first resolve. */
  codec?: "h264" | "hevc" | "av1" | "unknown";
  /** Parsed container format. */
  container?: "mp4" | "mkv" | "webm" | "mov" | "unknown";
}

function storedQualityFor(key: CachedStreamKey): string {
  return storedQualityForCache(key.provider, key.quality);
}

function whereFor(key: CachedStreamKey) {
  return {
    imdbId_mediaType_season_episode_quality_provider: {
      imdbId: key.imdbId,
      mediaType: key.mediaType,
      season: key.season ?? 0,
      episode: key.episode ?? 0,
      quality: storedQualityFor(key),
      provider: key.provider,
    },
  };
}

/** Fresh (non-expired) cached resolve, or null on miss/stale — caller re-resolves on null. Never throws. */
export async function getFreshCachedStream(key: CachedStreamKey): Promise<CachedStreamRecord | null> {
  try {
    const row = await db.cachedStream.findUnique({ where: whereFor(key) });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      title: row.title,
      source: row.source,
      url: row.url,
      compat: row.compat === "safari" ? "safari" : "native",
      ...(row.codec ? { codec: row.codec as CachedStreamRecord["codec"] } : {}),
      ...(row.container ? { container: row.container as CachedStreamRecord["container"] } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Expire a conclusively bad/duplicate row without deleting diagnostic data.
 * A failed replacement can therefore never be treated as fresh next time.
 */
export async function invalidateCachedStream(key: CachedStreamKey): Promise<void> {
  try {
    await db.cachedStream.update({
      where: whereFor(key),
      data: { expiresAt: new Date(0) },
    });
  } catch {
    // Missing row or DB failure: caller already excluded it from this response.
  }
}

/** Upsert the resolved link for this key. Cache-write failures must never break playback. */
export async function upsertCachedStream(
  key: CachedStreamKey,
  record: CachedStreamRecord,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    const shared = {
      title: record.title,
      source: record.source,
      url: record.url,
      compat: record.compat,
      expiresAt,
      ...(record.codec ? { codec: record.codec } : {}),
      ...(record.container ? { container: record.container } : {}),
    };
    await db.cachedStream.upsert({
      where: whereFor(key),
      create: {
        imdbId: key.imdbId,
        mediaType: key.mediaType,
        season: key.season ?? 0,
        episode: key.episode ?? 0,
        quality: storedQualityFor(key),
        provider: key.provider,
        ...shared,
      },
      update: shared,
    });
  } catch {
    // Swallow — next request just re-resolves instead of reading a cache hit.
  }
}
