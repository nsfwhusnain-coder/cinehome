import { db, withSqliteRetry } from "@/lib/db";
import type { PlayerFeedback } from "./types";
import {
  emptyRecord,
  foldFeedback,
  type SourceMemoryRecord,
  type SourceMemoryScope,
} from "./source-memory";

/**
 * Prisma-backed persistence for {@link SourceMemoryRecord}.
 *
 * All ranking logic lives in `source-memory.ts` and is pure; this module only
 * loads, folds and writes. Every write is best-effort: source memory is an
 * optimisation, so a locked database must never break playback.
 */

/** Rows kept per title. Beyond this the least useful are pruned. */
export const MAX_ROWS_PER_TITLE = 24;
/** Ignore absurd watch times (a wall-clock jump, a resumed laptop). */
export const MAX_WATCHED_MS_PER_EVENT = 6 * 60 * 60 * 1000;

interface StoredRow {
  sourceKey: string;
  provider: string;
  label: string;
  decodedHeight: number | null;
  codec: string | null;
  container: string | null;
  bitrateBps: number | null;
  playCount: number;
  failCount: number;
  shortPlayCount: number;
  stallCount: number;
  failStreak: number;
  watchedMs: number;
  ttffMsAvg: number | null;
  lastGoodAt: Date | null;
  lastFailAt: Date | null;
  lastReason: string | null;
}

function toRecord(row: StoredRow): SourceMemoryRecord {
  return {
    sourceKey: row.sourceKey,
    provider: row.provider,
    label: row.label,
    decodedHeight: row.decodedHeight,
    codec: row.codec,
    container: row.container,
    bitrateBps: row.bitrateBps,
    playCount: row.playCount,
    failCount: row.failCount,
    shortPlayCount: row.shortPlayCount,
    stallCount: row.stallCount,
    failStreak: row.failStreak,
    watchedMs: row.watchedMs,
    ttffMsAvg: row.ttffMsAvg,
    lastGoodAt: row.lastGoodAt ? row.lastGoodAt.getTime() : null,
    lastFailAt: row.lastFailAt ? row.lastFailAt.getTime() : null,
    lastReason: row.lastReason,
  };
}

function scopeWhere(scope: SourceMemoryScope) {
  return {
    tmdbId: scope.tmdbId,
    mediaType: scope.mediaType,
    season: scope.season,
    episode: scope.episode,
  };
}

/**
 * Every remembered source for one title, keyed by source id.
 * Returns an empty map on any failure — never throws into the playback path.
 */
export async function loadSourceMemory(
  scope: SourceMemoryScope
): Promise<Map<string, SourceMemoryRecord>> {
  try {
    const rows = (await withSqliteRetry(() =>
      db.sourceMemory.findMany({
        where: scopeWhere(scope),
        take: MAX_ROWS_PER_TITLE,
      })
    )) as StoredRow[];
    return new Map(rows.map((row) => [row.sourceKey, toRecord(row)]));
  } catch {
    return new Map();
  }
}

function persistPayload(next: SourceMemoryRecord) {
  return {
    provider: next.provider,
    label: next.label,
    decodedHeight: next.decodedHeight,
    codec: next.codec,
    container: next.container,
    bitrateBps: next.bitrateBps,
    playCount: next.playCount,
    failCount: next.failCount,
    shortPlayCount: next.shortPlayCount,
    stallCount: next.stallCount,
    failStreak: next.failStreak,
    watchedMs: next.watchedMs,
    ttffMsAvg: next.ttffMsAvg,
    lastGoodAt: next.lastGoodAt ? new Date(next.lastGoodAt) : null,
    lastFailAt: next.lastFailAt ? new Date(next.lastFailAt) : null,
    lastReason: next.lastReason,
  };
}

function boundedWatchedMs(feedback: PlayerFeedback): number {
  const raw = feedback.watchedMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), MAX_WATCHED_MS_PER_EVENT);
}

/**
 * Fold one player event into the stored row for this (title, source).
 *
 * Read-modify-write rather than an atomic increment: the fold is a state
 * machine (streaks reset, heights take a max, averages roll), which no single
 * SQL increment expresses. Contention is negligible — one viewer, one source.
 */
export async function recordSourceFeedback(
  scope: SourceMemoryScope,
  feedback: PlayerFeedback,
  label: string
): Promise<void> {
  const sourceKey = feedback.sourceId;
  if (!scope.tmdbId || !sourceKey) return;
  try {
    await withSqliteRetry(async () => {
      const existing = (await db.sourceMemory.findUnique({
        where: {
          tmdbId_mediaType_season_episode_sourceKey: {
            ...scopeWhere(scope),
            sourceKey,
          },
        },
      })) as StoredRow | null;

      const base = existing
        ? toRecord(existing)
        : emptyRecord(sourceKey, feedback.provider, label);
      const next = foldFeedback(base, feedback, boundedWatchedMs(feedback));

      await db.sourceMemory.upsert({
        where: {
          tmdbId_mediaType_season_episode_sourceKey: {
            ...scopeWhere(scope),
            sourceKey,
          },
        },
        create: { ...scopeWhere(scope), sourceKey, ...persistPayload(next) },
        update: persistPayload(next),
      });
    });
  } catch {
    // Best-effort: memory is an optimisation, never a playback dependency.
  }
}

/**
 * Keep the table small. Rows that never produced a watchable play are the
 * first to go, oldest first — a proven row is the whole point and is retained.
 */
export async function pruneSourceMemory(
  scope: SourceMemoryScope
): Promise<void> {
  try {
    const rows = (await db.sourceMemory.findMany({
      where: scopeWhere(scope),
      orderBy: [{ watchedMs: "asc" }, { updatedAt: "asc" }],
      select: { id: true },
    })) as { id: string }[];
    if (rows.length <= MAX_ROWS_PER_TITLE) return;
    const excess = rows.slice(0, rows.length - MAX_ROWS_PER_TITLE);
    await db.sourceMemory.deleteMany({
      where: { id: { in: excess.map((row) => row.id) } },
    });
  } catch {
    // Non-fatal.
  }
}
