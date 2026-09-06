import type { PlaybackSource, PlayerFeedback } from "./types";

/**
 * Per-title source memory.
 *
 * The provider health registry answers "is this provider healthy right now?" —
 * ephemeral, cross-title, gone on restart. This answers a different and durable
 * question: **did this specific server actually deliver a good, complete,
 * correctly-identified stream for THIS title?**
 *
 * What is remembered is the source *identity plus the evidence it produced* —
 * never the URL. Debrid links, HLS session ids and CDN tokens all rot within
 * hours, so a remembered URL is a guaranteed dead link. A remembered identity
 * ("Quasar served real 3840x2160 H.264 for tmdb:27205 and someone watched 40
 * minutes of it") stays true, and the normal resolve re-fetches a fresh URL for
 * that server on the next visit.
 *
 * Storage is metadata only: one small row per (title, source), no media.
 */

/** Watched time that proves a real play rather than an opened-then-abandoned stream. */
export const PROVEN_WATCH_MS = 90_000;
/** Below this, repeated across plays, the file is a sample/trailer/wrong title. */
export const SHORT_PLAY_MS = 20_000;
/** Plays with sustained watch time before a source may be trusted outright. */
export const PROVEN_MIN_PLAYS = 1;
/** Evidence older than this is kept but demoted — encodes get replaced upstream. */
export const MEMORY_FRESH_DAYS = 30;
/** Failure ratio at or above which a source is refused as the automatic pick. */
export const DISTRUST_FAIL_RATIO = 0.5;
/** Consecutive terminal failures that distrust a source regardless of history. */
export const DISTRUST_STREAK = 3;
/** Short plays at or above this count mean the file itself is wrong, not the network. */
export const WRONG_CONTENT_SHORT_PLAYS = 3;
/** Stall ratio above which playback is technically "working" but not watchable. */
export const STALL_PRONE_RATIO = 0.6;
/** Rolling-average cap so one pathological cold start cannot poison the mean. */
export const MAX_TRACKED_TTFF_MS = 180_000;

const MS_PER_DAY = 86_400_000;

export type SourceTrust = "proven" | "probation" | "distrusted" | "unknown";

export type SourceDisqualifier =
  | "wrong_content"
  | "corrupt"
  | "incompatible"
  | "stall_prone"
  | "fails_open";

/** One durable row: a single logical server's track record on a single title. */
export interface SourceMemoryRecord {
  sourceKey: string;
  provider: string;
  label: string;
  /** Highest resolution the player actually *decoded*, not a label or a guess. */
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
  lastGoodAt: number | null;
  lastFailAt: number | null;
  lastReason: string | null;
}

/** Identifies the title a memory row belongs to. Episodes are distinct rows. */
export interface SourceMemoryScope {
  tmdbId: string;
  mediaType: "movie" | "tv";
  season: number;
  episode: number;
}

export function sourceMemoryScope(
  tmdbId: string,
  mediaType: "movie" | "tv",
  season?: number | null,
  episode?: number | null
): SourceMemoryScope {
  return {
    tmdbId: String(tmdbId).trim(),
    mediaType,
    season: mediaType === "tv" ? Math.max(0, season ?? 0) : 0,
    episode: mediaType === "tv" ? Math.max(0, episode ?? 0) : 0,
  };
}

export function emptyRecord(
  sourceKey: string,
  provider: string,
  label: string
): SourceMemoryRecord {
  return {
    sourceKey,
    provider,
    label,
    decodedHeight: null,
    codec: null,
    container: null,
    bitrateBps: null,
    playCount: 0,
    failCount: 0,
    shortPlayCount: 0,
    stallCount: 0,
    failStreak: 0,
    watchedMs: 0,
    ttffMsAvg: null,
    lastGoodAt: null,
    lastFailAt: null,
    lastReason: null,
  };
}

function rollingAverage(
  previous: number | null,
  samples: number,
  next: number
): number {
  const bounded = Math.min(Math.max(0, Math.round(next)), MAX_TRACKED_TTFF_MS);
  if (previous === null || samples <= 0) return bounded;
  return Math.round((previous * samples + bounded) / (samples + 1));
}

/**
 * A first frame is not yet a success — a corrupt or wrong file also renders one
 * frame. Success is claimed by `watchedMs` arriving later via `sustained_play`.
 */
function applyFirstFrame(
  record: SourceMemoryRecord,
  feedback: PlayerFeedback
): SourceMemoryRecord {
  const ttff = feedback.timeToFirstFrameMs;
  return {
    ...record,
    playCount: record.playCount + 1,
    failStreak: 0,
    ttffMsAvg:
      typeof ttff === "number"
        ? rollingAverage(record.ttffMsAvg, record.playCount, ttff)
        : record.ttffMsAvg,
    decodedHeight: Math.max(
      record.decodedHeight ?? 0,
      feedback.decodedHeight ?? 0
    ) || null,
    lastGoodAt: feedback.occurredAt,
  };
}

function applyFailure(
  record: SourceMemoryRecord,
  feedback: PlayerFeedback
): SourceMemoryRecord {
  return {
    ...record,
    failCount: record.failCount + 1,
    failStreak: record.failStreak + 1,
    lastFailAt: feedback.occurredAt,
    lastReason: feedback.reason ?? feedback.errorDetail ?? feedback.event,
  };
}

function applySustainedPlay(
  record: SourceMemoryRecord,
  feedback: PlayerFeedback,
  watchedMs: number
): SourceMemoryRecord {
  const short = watchedMs > 0 && watchedMs < SHORT_PLAY_MS;
  return {
    ...record,
    watchedMs: record.watchedMs + Math.max(0, watchedMs),
    shortPlayCount: short ? record.shortPlayCount + 1 : record.shortPlayCount,
    decodedHeight: Math.max(
      record.decodedHeight ?? 0,
      feedback.decodedHeight ?? 0
    ) || null,
    lastGoodAt: short ? record.lastGoodAt : feedback.occurredAt,
  };
}

/**
 * Fold one player event into a record. Pure — the caller persists the result.
 * `watchedMs` is supplied separately because the player tracks it continuously
 * and reports it on teardown, not as part of a discrete feedback event.
 */
export function foldFeedback(
  record: SourceMemoryRecord,
  feedback: PlayerFeedback,
  watchedMs = 0
): SourceMemoryRecord {
  switch (feedback.event) {
    case "first_frame":
      return applyFirstFrame(record, feedback);
    case "decoded_resolution":
      return {
        ...record,
        decodedHeight:
          Math.max(record.decodedHeight ?? 0, feedback.decodedHeight ?? 0) ||
          null,
      };
    case "stall":
      return { ...record, stallCount: record.stallCount + 1 };
    case "handoff_failed":
    case "decode_error":
      return applyFailure(record, feedback);
    default:
      return watchedMs > 0
        ? applySustainedPlay(record, feedback, watchedMs)
        : record;
  }
}

/**
 * The user's explicit list: not the wrong video, not corrupt, not an
 * undecodable format, not something that technically plays but stutters.
 * Each is inferred from evidence the player already produces.
 */
export function disqualifier(
  record: SourceMemoryRecord
): SourceDisqualifier | null {
  if (record.shortPlayCount >= WRONG_CONTENT_SHORT_PLAYS && record.watchedMs < PROVEN_WATCH_MS) {
    return "wrong_content";
  }
  if (record.playCount === 0 && record.failCount >= DISTRUST_STREAK) {
    return "corrupt";
  }
  if (record.lastReason === "codec_unsupported" || record.lastReason === "container_unsupported") {
    return "incompatible";
  }
  if (record.failStreak >= DISTRUST_STREAK) return "fails_open";
  const attempts = record.playCount + record.failCount;
  if (attempts > 0 && record.failCount / attempts >= DISTRUST_FAIL_RATIO) {
    return "fails_open";
  }
  if (
    record.playCount > 0 &&
    record.stallCount / record.playCount > STALL_PRONE_RATIO
  ) {
    return "stall_prone";
  }
  return null;
}

function isFresh(record: SourceMemoryRecord, now: number): boolean {
  if (record.lastGoodAt === null) return false;
  return now - record.lastGoodAt <= MEMORY_FRESH_DAYS * MS_PER_DAY;
}

export function trustLevel(
  record: SourceMemoryRecord | undefined,
  now: number = Date.now()
): SourceTrust {
  if (!record) return "unknown";
  if (disqualifier(record)) return "distrusted";
  const sustained =
    record.playCount >= PROVEN_MIN_PLAYS && record.watchedMs >= PROVEN_WATCH_MS;
  if (sustained && isFresh(record, now)) return "proven";
  if (record.playCount > 0) return "probation";
  return "unknown";
}

/**
 * Ranking weight, highest first. Deliberately coarse: memory orders sources
 * that quality evidence has already tied, and must never outrank a genuinely
 * higher resolution — `applySourceMemory` enforces that by only reordering
 * within an equal-height band.
 */
export function memoryRank(
  record: SourceMemoryRecord | undefined,
  now: number = Date.now()
): number {
  const trust = trustLevel(record, now);
  if (trust === "proven") return 3;
  if (trust === "probation") return 1;
  if (trust === "distrusted") return -1;
  return 0;
}

export interface RememberedSource<T> {
  source: T;
  record: SourceMemoryRecord | undefined;
  trust: SourceTrust;
  rank: number;
}

function heightBand(source: PlaybackSource): number {
  const height = source.maxHeight ?? 0;
  if (height >= 2160) return 3;
  if (height >= 1080) return 2;
  if (height > 0) return 1;
  return 2; // unknown ranks with HD — never assume the worst (see source-quality)
}

/**
 * Order sources by memory *within* an equal-resolution band.
 *
 * The band guard is the whole safety story: a fondly-remembered 1080p can never
 * displace an available 4K, which is what the owner asked for. Inside a band,
 * a proven source leads and a distrusted one sinks below unknowns.
 */
export function applySourceMemory<T extends PlaybackSource>(
  sources: readonly T[],
  records: ReadonlyMap<string, SourceMemoryRecord>,
  keyOf: (source: T) => string,
  now: number = Date.now()
): T[] {
  const annotated: RememberedSource<T>[] = sources.map((source) => {
    const record = records.get(keyOf(source));
    return {
      source,
      record,
      trust: trustLevel(record, now),
      rank: memoryRank(record, now),
    };
  });
  return annotated
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const bandDelta = heightBand(b.entry.source) - heightBand(a.entry.source);
      if (bandDelta !== 0) return bandDelta;
      if (a.entry.rank !== b.entry.rank) return b.entry.rank - a.entry.rank;
      return a.index - b.index; // stable: preserve upstream ranking
    })
    .map(({ entry }) => entry.source);
}

/**
 * The "kinda instant" path: a proven source seen in the fast/partial roster is
 * worth starting on immediately rather than waiting out the full discovery
 * wall. Returns null when nothing is proven, so the normal ranking decides.
 */
export function pickProvenSource<T extends PlaybackSource>(
  sources: readonly T[],
  records: ReadonlyMap<string, SourceMemoryRecord>,
  keyOf: (source: T) => string,
  now: number = Date.now()
): T | null {
  let best: T | null = null;
  let bestHeight = -1;
  for (const source of sources) {
    if (trustLevel(records.get(keyOf(source)), now) !== "proven") continue;
    const height = source.maxHeight ?? 0;
    if (height > bestHeight) {
      best = source;
      bestHeight = height;
    }
  }
  return best;
}
