/**
 * PREMIUM 4K/1080p debrid tier — orchestration entry point.
 *
 * TMDB id -> IMDb id -> Torrentio (RD-configured, cache-detection only) ->
 * (fallback) our own RD add/select/poll/unrestrict for any raw infoHash
 * Torrentio didn't resolve itself -> PlaybackSource[], cache-first.
 *
 * REAL-DEBRID IS THE FAST, HIGH-VOLUME, PRIMARY ENGINE. A popular title has
 * 150-224 fully RD-cached streams, so instead of caching a single "best"
 * source per resolution (the old 2-row model), RD now caches a small ROSTER
 * of up to 5 distinct sources per title — see `RdSlot`:
 *   - "native-2160"   best browser-safe H.264/MP4 4K (rare: 0-8/title)
 *   - "safari-2160"   best HEVC/MP4 4K, tagged compat:"safari" (60-117/title
 *                      exist, but only in a browser that can decode HEVC)
 *   - "native-1080-1/2/3"  several distinct browser-safe H.264/MP4 1080p
 *                      releases (14-37/title exist)
 *   - "native-720"      one browser-safe availability fallback, considered
 *                      only when no native 4K/1080p source exists
 * "Best native" (the auto-default target) falls out of this for free: the
 * existing (unowned) scoring in source-quality.ts already ranks a native
 * 2160p source above a native 1080p one, so whichever height actually landed
 * a native slot naturally becomes the default.
 *
 * Explicit MKV/WebM candidates remain in the inventory with their honest
 * container/compat metadata, but the player never auto-selects a container
 * the current browser cannot play. Native candidates whose container is
 * unknown are stricter: their resolved object must prove an ISO-BMFF
 * (MP4/MOV) signature before it can be cached or surfaced. This prevents
 * Blu-ray M2TS objects from masquerading as browser-native sources.
 *
 * FAST PATH (see `resolveFastDebridSources`, called from route.ts's `fast`/
 * `prefetch` branch): CACHE-ONLY — one direct TMDB-keyed SQLite query against
 * a short-lived, versioned trust namespace. Full resolution writes that
 * namespace only after conclusive size + ISO-BMFF proof. It never performs an
 * IMDb lookup, live validation, provider construction, Torrentio/RD request,
 * or background enrichment. On a miss it returns `[]`; the client's separate
 * full request owns all live discovery and roster enrichment.
 *
 * FULL PATH (`resolveDebridSources`, unchanged export used by
 * src/app/api/playback/[type]/[id]/route.ts's non-fast branch): resolves
 * (or reads from cache) the entire RD roster, bounded by
 * `RD_FULL_DEADLINE_MS` (~12s) shared across every slot's resolve attempts.
 *
 * TorBox (torbox.ts) is a SIBLING debrid source resolved alongside RD in the
 * same call (full path only — TorBox's add/poll/requestdl flow is far too
 * slow and quota-constrained for the fast path), and works FULLY STANDALONE
 * — it needs only provider-agnostic raw BitTorrent `infoHash` values, which
 * it gets from Torrentio's UN-configured (no-debrid) endpoint
 * (`fetchTorrentioCandidatesNoDebrid`) when Real-Debrid is absent, or reuses
 * the RD-configured candidate list's infoHashes when RD is present (avoids a
 * duplicate fetch). It then runs its own cache check + add/poll/requestdl
 * flow on api.torbox.app, cached independently in the same `CachedStream`
 * table (keyed by `provider`). Each tier is fully isolated — a TorBox
 * failure never affects RD (or vice versa), and either can be absent with
 * zero effect on the other. TorBox's own quota-bounded 2-row-per-title model
 * (one per height) is UNCHANGED by this file's RD roster expansion.
 *
 * The TorBox API key is NEVER placed in a Torrentio (or any third-party)
 * request — Torrentio only ever sees an RD token (RD path) or no token at
 * all (TorBox-only path). So the owner can run TorBox's free 1080p tier
 * WITHOUT ever configuring or paying for Real-Debrid.
 *
 * `resolveDebridSources` / `resolveFastDebridSources` NEVER throw and NO-OP
 * to `[]` whenever NEITHER `REAL_DEBRID_API_TOKEN` NOR `TORBOX_API_KEY` is
 * set (fast path only ever looks at RD) — the existing embed roster is
 * completely unaffected until the owner opts into at least one.
 */
import type { MediaType, PlaybackSource } from "../types";
import {
  fetchTorrentioCandidates,
  fetchTorrentioCandidatesNoDebrid,
  resolveImdbId,
  type DebridCandidate,
  type ReleaseCodec,
  type ReleaseCompat,
  type ReleaseContainer,
} from "./torrentio";
import {
  isRealDebridConfigured,
  mapWithConcurrency,
  resolveDebridDirectLink,
  RESOLVE_CONCURRENCY,
} from "./realdebrid";
import {
  isTorBoxConfigured,
  checkCachedTorboxHashes,
  resolveTorboxDirectLink,
  torboxDeadlineFromNow,
  type TorboxResolvedFile,
} from "./torbox";
import {
  getFreshCachedStream,
  getTrustedFastCachedStreams,
  invalidateCachedStream,
  invalidateTrustedFastCachedStream,
  upsertCachedStream,
  upsertTrustedFastCachedStream,
  type DebridQuality,
  type DebridSlot,
  type DebridProvider,
  type CachedStreamRecord,
} from "./cached-stream";
import { resolveTokenFreeRedirect, sanitizeStreamUrl, sanitizeTorboxStreamUrl } from "./token-safety";
import {
  validateDebridMediaLink,
  validateNativeBrowserContainer,
  type MediaValidationResult,
} from "./media-validation";

/** TorBox tier only — unchanged 2-row-per-title model (quota-bounded). */
const QUALITIES: DebridQuality[] = ["2160p", "1080p"];

/**
 * The full Real-Debrid roster — see module header. Order doubles as resolve
 * priority when multiple slots are missing (native picks before the rarer
 * Safari-only 4K pick), though all missing slots resolve concurrently up to
 * `RESOLVE_CONCURRENCY` regardless of this order.
 */
const RD_SLOTS: DebridSlot[] = [
  "native-2160",
  "safari-2160",
  "native-1080-1",
  "native-1080-2",
  "native-1080-3",
  "native-720",
];

/**
 * Fast/prefetch path bound — a DEFENSIVE backstop only, not a live-network
 * budget: the fast path is cache-only (see `resolveFastBestNativeFromCache`),
 * so this only ever has to cover one bounded `CachedStream` DB query. A cache
 * hit resolves in low single-digit ms; this ceiling exists purely so a
 * pathological slow DB read can never hold up the fast TTFF response. The
 * client's independent full request owns all live provider work.
 */
const RD_FAST_DEADLINE_MS = 1_500;
/** Full-resolve path bound — shared across every missing RD slot's resolve attempts (including any per-slot fallback to the next-ranked candidate). */
const RD_FULL_DEADLINE_MS = 12_000;
/** Per-call ceiling for a single `resolveTokenFreeRedirect`, clamped down further by whatever remains of the shared deadline. */
const RD_RESOLVE_TIMEOUT_CEILING_MS = 8_000;
/** Range-probe ceiling inside the shared full-resolve budget. */
const RD_MEDIA_VALIDATION_TIMEOUT_MS = 2_000;

/**
 * QUOTA CAP — TorBox's FREE tier allows only ~10 torrent adds/month, and each
 * `createtorrent` consumes one. A single lookup therefore adds AT MOST this
 * many torrents across all surfaced quality tiers AND any fallback attempts
 * combined: on the happy path a two-quality resolve costs 2 adds (one per
 * tier), a one-quality resolve costs 1, and a failed winner may be retried
 * with the next-ranked candidate only until this shared budget is exhausted.
 * A resolved cache hit (see cached-stream.ts) costs ZERO adds.
 */
const MAX_TORBOX_ADDS_PER_LOOKUP = 2;

export interface ResolveDebridSourcesRequest {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  /** Discard signed RD links after the player proves the roster is dead. */
  forceRefresh?: boolean;
}

interface ResolvedCandidate extends DebridCandidate {
  directUrl: string;
  /** Eligible for the short, zero-network fast cache after conclusive proof. */
  fastTrusted?: boolean;
}

interface KeyBase {
  imdbId: string;
  mediaType: MediaType;
  season: number;
  episode: number;
}

function heightForQuality(quality: DebridQuality): 1080 | 2160 {
  return quality === "2160p" ? 2160 : 1080;
}

type RdQuality = DebridQuality | "720p";

function qualityLabel(quality: RdQuality): string {
  return quality === "2160p" ? "4K" : quality;
}

/** RD keeps its original "debrid-" id prefix unchanged (zero regression); TorBox gets its own distinct prefix. */
function buildSourceId(
  provider: DebridProvider,
  imdbId: string,
  mediaType: MediaType,
  season: number,
  episode: number,
  slotOrQuality: string
): string {
  const prefix = provider === "torbox" ? "torbox" : "debrid";
  return `${prefix}-${imdbId}-${mediaType}-${season}-${episode}-${slotOrQuality}`;
}

/** Display name shown in `PlaybackSource.provider` / picker labels — distinguishes TorBox from RD in the UI while both keep `origin: "debrid"` for ranking. */
function providerDisplayName(provider: DebridProvider): string {
  return provider === "torbox" ? "TorBox" : "Debrid";
}

/** RD's exact original label format ("1080p • Debrid") is preserved unchanged; TorBox uses its own distinct format ("TorBox · 1080p"). */
function buildLabel(provider: DebridProvider, quality: RdQuality, safariHint: string): string {
  const q = qualityLabel(quality);
  if (provider === "torbox") return `TorBox · ${q}${safariHint}`;
  return `${q} • Debrid${safariHint}`;
}

/** TorBox tier only (unchanged 2-row-per-title shape). Real-Debrid uses `toRdPlaybackSource` below for its richer slot roster. */
function toPlaybackSource(
  provider: DebridProvider,
  quality: DebridQuality,
  imdbId: string,
  mediaType: MediaType,
  season: number,
  episode: number,
  record: Pick<CachedStreamRecord, "url" | "compat">,
  codec?: "h264" | "hevc" | "unknown"
): PlaybackSource {
  const height = heightForQuality(quality);
  const safariHint = record.compat === "safari" ? " · Safari" : "";
  return {
    id: buildSourceId(provider, imdbId, mediaType, season, episode, quality),
    url: record.url,
    provider: providerDisplayName(provider),
    quality,
    label: buildLabel(provider, quality, safariHint),
    type: "mp4",
    maxHeight: height,
    origin: "debrid",
    compat: record.compat,
    ...(codec ? { codec } : {}),
  };
}

// ---------------------------------------------------------------------------
// Real-Debrid roster (fast + full paths)
// ---------------------------------------------------------------------------

function slotHeight(slot: DebridSlot): 720 | 1080 | 2160 {
  if (slot === "native-720") return 720;
  return slot === "native-2160" || slot === "safari-2160" ? 2160 : 1080;
}

function slotQuality(slot: DebridSlot): RdQuality {
  const height = slotHeight(slot);
  return height === 2160 ? "2160p" : height === 1080 ? "1080p" : "720p";
}

/** Infer only an explicit media extension from a token-free direct URL.
 * Legacy cache rows may predate persisted container metadata; without this
 * bridge an H.264-in-MKV URL is mislabeled native and handed to `<video>`. */
function explicitUrlContainer(url: string): ReleaseContainer | undefined {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    if (/\.mkv$/.test(pathname)) return "mkv";
    if (/\.webm$/.test(pathname)) return "webm";
    if (/\.mp4$/.test(pathname)) return "mp4";
    if (/\.mov$/.test(pathname)) return "mov";
  } catch {
    // An opaque but already-sanitized URL remains unknown, never fabricated.
  }
  return undefined;
}

function effectiveReleaseContainer(
  url: string,
  parsed?: ReleaseContainer
): ReleaseContainer | undefined {
  // The final CDN object's explicit extension is more authoritative than
  // release-title metadata persisted before a redirect.
  const explicit = explicitUrlContainer(url);
  if (explicit) return explicit;
  return parsed;
}

/** Builds the honestly-tagged `PlaybackSource` for one RD roster slot. */
function toRdPlaybackSource(
  slot: DebridSlot,
  imdbId: string,
  mediaType: MediaType,
  season: number,
  episode: number,
  record: Pick<CachedStreamRecord, "url" | "compat">,
  codec?: ReleaseCodec,
  container?: ReleaseContainer
): PlaybackSource {
  const height = slotHeight(slot);
  const quality = slotQuality(slot);
  const safariHint = record.compat === "safari" ? " · Safari" : "";
  const effectiveContainer = effectiveReleaseContainer(record.url, container);
  return {
    id: buildSourceId("realdebrid", imdbId, mediaType, season, episode, slot),
    url: record.url,
    provider: "Debrid",
    quality,
    label: buildLabel("realdebrid", quality, safariHint),
    type: "mp4",
    maxHeight: height,
    origin: "debrid",
    compat: record.compat,
    ...(codec && codec !== "unknown" ? { codec } : {}),
    ...(effectiveContainer && effectiveContainer !== "unknown"
      ? { container: effectiveContainer }
      : {}),
  };
}

function nativeCandidatesAt(
  candidates: DebridCandidate[],
  height: 720 | 1080 | 2160
): DebridCandidate[] {
  return candidates.filter((c) => c.compat === "native" && c.resolutionHeight === height);
}

function safariCandidatesAt(candidates: DebridCandidate[], height: 1080 | 2160): DebridCandidate[] {
  return candidates.filter((c) => c.compat === "safari" && c.resolutionHeight === height);
}

/**
 * Per-slot ranked candidate options — already-ranked lists (torrentio.ts
 * ranks by media-type size fitness, bounded seeders, and container confidence
 * per class). All missing native-1080 slots share one ordered pool; the
 * resolver validates that pool in bounded batches and assigns only the first
 * successful candidates in rank order.
 */
function candidateHashIdentity(candidate: DebridCandidate): string | null {
  return candidate.infoHash ? `hash:${candidate.infoHash.toLowerCase()}` : null;
}

function releaseTitleIdentity(title: string): string | null {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalized ? `title:${normalized}` : null;
}

function cachedIdentities(record: CachedStreamRecord, safeUrl: string): string[] {
  const titleIdentity = releaseTitleIdentity(record.title);
  const identities = [`url:${safeUrl}`, ...(titleIdentity ? [titleIdentity] : [])];
  if (/^[a-f0-9]{40}$/i.test(record.source)) {
    identities.push(`hash:${record.source.toLowerCase()}`);
  } else if (record.source) {
    identities.push(`source:${record.source}`);
  }
  return identities;
}

function buildRdSlotOptions(
  candidates: DebridCandidate[],
  missing: DebridSlot[],
  occupiedIdentities: Set<string>
): Record<DebridSlot, DebridCandidate[]> {
  const available = (items: DebridCandidate[]) => {
    const seen = new Set<string>();
    return items.filter((candidate) => {
      const hashIdentity = candidateHashIdentity(candidate);
      const titleIdentity = releaseTitleIdentity(candidate.title);
      const identities = [
        ...(hashIdentity ? [hashIdentity] : []),
        ...(titleIdentity ? [titleIdentity] : []),
        ...(candidate.url ? [`candidate-url:${candidate.url}`] : []),
      ];
      if (identities.some((identity) => occupiedIdentities.has(identity))) return false;
      // Torrentio can return the same hash more than once under slightly
      // different labels. Deduplicate before lane allocation or those copies
      // can still land in separate concurrent slots.
      if (identities.some((identity) => seen.has(identity))) return false;
      identities.forEach((identity) => seen.add(identity));
      return true;
    });
  };
  const result: Record<DebridSlot, DebridCandidate[]> = {
    "native-2160": available(nativeCandidatesAt(candidates, 2160)),
    "safari-2160": available(safariCandidatesAt(candidates, 2160)),
    "native-1080-1": [],
    "native-1080-2": [],
    "native-1080-3": [],
    "native-720": available(nativeCandidatesAt(candidates, 720)),
  };

  // Keep one shared ranked pool. Disjoint round-robin lanes prevented
  // duplicates, but when rank 0 failed they promoted rank 3 into slot 1 while
  // ranks 1 and 2 landed in slots 2/3. Ordered batched resolution below keeps
  // parallelism without breaking quality order.
  const nativeSlots = missing.filter((slot) => slot.startsWith("native-1080")) as DebridSlot[];
  const native1080 = available(nativeCandidatesAt(candidates, 1080));
  nativeSlots.forEach((slot) => {
    result[slot] = native1080;
  });
  return result;
}

/**
 * Resolve a single Torrentio candidate to a direct-playable, TOKEN-FREE link
 * — path (a) first, path (b) fallback. Bounded by the shared `deadline`:
 * path (a)'s `resolveTokenFreeRedirect` timeout is clamped to whatever time
 * remains (never more than `RD_RESOLVE_TIMEOUT_CEILING_MS`), and path (b) is
 * skipped entirely once the deadline has passed.
 *
 * `candidate.url` (when present) is Torrentio's own resolve-proxy link and
 * contains the live RD token in its path
 * (`.../resolve/realdebrid/<token>/...`). It is NEVER used as-is: we follow
 * it server-side (`resolveTokenFreeRedirect`) to the final, token-free Real-
 * Debrid CDN link before it can become a `directUrl`. The token-bearing URL
 * never leaves this function. If it can't be reduced to a safe URL (network
 * failure, timeout, or the final URL somehow still carries the token), we
 * fall through to path (b) — our own add/select/poll/unrestrict flow — when
 * a raw infoHash is available and the deadline allows it, rather than ever
 * handing back the resolve link itself.
 */
async function resolveCandidateLink(
  candidate: DebridCandidate,
  token: string,
  deadline: number
): Promise<ResolvedCandidate | null> {
  if (candidate.url) {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      const timeoutMs = Math.min(RD_RESOLVE_TIMEOUT_CEILING_MS, remaining);
      const tokenFreeUrl = await resolveTokenFreeRedirect(candidate.url, token, timeoutMs);
      if (tokenFreeUrl) return { ...candidate, directUrl: tokenFreeUrl };
    }
  }
  if (!candidate.infoHash || Date.now() >= deadline) return null;
  const directUrl = await resolveDebridDirectLink(candidate.infoHash, candidate.fileIdx);
  const safeUrl = sanitizeStreamUrl(directUrl, token);
  return safeUrl ? { ...candidate, directUrl: safeUrl } : null;
}

/** Tries each ranked option for one slot in order, stopping at the first that resolves or when the shared deadline passes. */
async function resolveSlotCandidate(
  options: DebridCandidate[],
  token: string,
  deadline: number,
  mediaType: MediaType,
  occupiedIdentities: Set<string>
): Promise<ResolvedCandidate | null> {
  for (const candidate of options) {
    if (Date.now() >= deadline) return null;
    const resolved = await resolveCandidateLink(candidate, token, deadline);
    if (!resolved) continue;
    if (occupiedIdentities.has(`url:${resolved.directUrl}`)) {
      console.warn(
        JSON.stringify({
          event: "debrid_resolved_duplicate_rejected",
          provider: "realdebrid",
          mediaType,
          title: candidate.title,
        })
      );
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const validation = await validateDebridMediaLink(
      resolved.directUrl,
      mediaType,
      Math.min(RD_MEDIA_VALIDATION_TIMEOUT_MS, remaining)
    );
    if (!validation.acceptable) {
      logRejectedRdMedia(candidate, validation, mediaType, "fresh");
      continue;
    }

    const effectiveContainer = effectiveReleaseContainer(
      resolved.directUrl,
      resolved.container
    );
    if (resolved.compat === "native") {
      const explicitContainer = explicitUrlContainer(resolved.directUrl);
      const parsedContainer =
        resolved.container && resolved.container !== "unknown"
          ? resolved.container
          : undefined;
      const metadataConflict =
        explicitContainer &&
        parsedContainer &&
        explicitContainer !== parsedContainer;
      if (
        metadataConflict ||
        effectiveContainer === "mkv" ||
        effectiveContainer === "webm"
      ) {
        logRejectedRdMedia(
          candidate,
          {
            acceptable: false,
            reason: "unsupported_container",
            totalBytes: validation.totalBytes,
            status: validation.status,
            elapsedMs: validation.elapsedMs,
          },
          mediaType,
          "fresh"
        );
        continue;
      }

      const containerRemaining = deadline - Date.now();
      if (containerRemaining <= 0) return null;
      const containerValidation = await validateNativeBrowserContainer(
        resolved.directUrl,
        Math.min(RD_MEDIA_VALIDATION_TIMEOUT_MS, containerRemaining)
      );
      if (containerValidation.acceptable && containerValidation.container) {
        return {
          ...resolved,
          container: containerValidation.container,
          fastTrusted:
            validation.reason === "plausible_size" &&
            resolved.codec === "h264",
        };
      }

      // A known MP4/MOV may remain available to the full roster when a
      // signature probe merely timed out, but it is never written to the
      // zero-network trust namespace. Unknown containers and conclusive
      // signature/HTTP failures fail closed.
      if (
        containerValidation.reason !== "network_indeterminate" ||
        (effectiveContainer !== "mp4" && effectiveContainer !== "mov")
      ) {
        logRejectedRdMedia(
          candidate,
          {
            acceptable: false,
            reason: "unsupported_container",
            totalBytes: validation.totalBytes,
            status: containerValidation.status,
            elapsedMs: validation.elapsedMs + containerValidation.elapsedMs,
          },
          mediaType,
          "fresh"
        );
        continue;
      }
    }

    return resolved;
  }
  return null;
}

/**
 * Resolve the first N valid candidates from one ranked pool. Each batch runs
 * concurrently, but results are consumed in candidate order, so a failed
 * winner cannot cause rank 4 to occupy slot 1 while ranks 2/3 occupy later
 * slots. Batch width shrinks as the roster fills to avoid needless RD calls.
 */
async function resolveRankedCandidatePool(
  options: DebridCandidate[],
  count: number,
  token: string,
  deadline: number,
  mediaType: MediaType,
  occupiedIdentities: Set<string>
): Promise<ResolvedCandidate[]> {
  const resolvedCandidates: ResolvedCandidate[] = [];
  const claimedIdentities = new Set(occupiedIdentities);
  let cursor = 0;

  while (
    cursor < options.length &&
    resolvedCandidates.length < count &&
    Date.now() < deadline
  ) {
    const remainingNeeded = count - resolvedCandidates.length;
    const batch = options.slice(
      cursor,
      cursor + Math.min(RESOLVE_CONCURRENCY, remainingNeeded)
    );
    cursor += batch.length;
    const batchResults = await mapWithConcurrency(
      batch,
      RESOLVE_CONCURRENCY,
      (candidate) =>
        resolveSlotCandidate(
          [candidate],
          token,
          deadline,
          mediaType,
          occupiedIdentities
        )
    );

    for (const resolved of batchResults) {
      if (!resolved || resolvedCandidates.length >= count) continue;
      const hashIdentity = candidateHashIdentity(resolved);
      const titleIdentity = releaseTitleIdentity(resolved.title);
      const identities = [
        `url:${resolved.directUrl}`,
        ...(hashIdentity ? [hashIdentity] : []),
        ...(titleIdentity ? [titleIdentity] : []),
      ];
      if (identities.some((identity) => claimedIdentities.has(identity))) {
        console.warn(
          JSON.stringify({
            event: "debrid_resolved_duplicate_rejected",
            provider: "realdebrid",
            mediaType,
            title: resolved.title,
          })
        );
        continue;
      }
      identities.forEach((identity) => {
        claimedIdentities.add(identity);
        occupiedIdentities.add(identity);
      });
      resolvedCandidates.push(resolved);
    }
  }

  return resolvedCandidates;
}

function logRejectedRdMedia(
  record: Pick<CachedStreamRecord, "title">,
  validation: MediaValidationResult,
  mediaType: MediaType,
  path: "fresh" | "cache",
  imdbId?: string,
  slot?: DebridSlot
): void {
  console.warn(
    JSON.stringify({
      event: "debrid_media_rejected",
      provider: "realdebrid",
      path,
      mediaType,
      ...(imdbId ? { imdbId } : {}),
      ...(slot ? { slot } : {}),
      title: record.title,
      reason: validation.reason,
      totalBytes: validation.totalBytes,
      status: validation.status,
      validationMs: validation.elapsedMs,
    })
  );
}

/** Cache-first read across the RD roster — unsafe, dead, or implausibly small rows are misses. */
async function readCachedRdSlots(
  keyBase: KeyBase,
  rdToken: string,
  tmdbId: number,
  validationTimeoutMs: number = RD_MEDIA_VALIDATION_TIMEOUT_MS
): Promise<{ hits: PlaybackSource[]; missing: DebridSlot[]; occupiedIdentities: Set<string> }> {
  const cachedBySlot = await Promise.all(
    RD_SLOTS.map((slot) => getFreshCachedStream({ ...keyBase, quality: slot, provider: "realdebrid" }))
  );
  const validatedBySlot = await Promise.all(
    cachedBySlot.map(async (hit, index) => {
      const slot = RD_SLOTS[index]!;
      const safeUrl = hit ? sanitizeStreamUrl(hit.url, rdToken) : null;
      const trustKey = {
        ...keyBase,
        tmdbId,
        quality: slot,
      };
      if (!hit || !safeUrl) {
        if (hit) await invalidateTrustedFastCachedStream(trustKey);
        return { hit, safeUrl: null, validation: null };
      }
      const validation = await validateDebridMediaLink(
        safeUrl,
        keyBase.mediaType,
        validationTimeoutMs
      );
      const effectiveContainer = effectiveReleaseContainer(
        safeUrl,
        hit.container
      );
      if (validation.acceptable && hit.compat === "native") {
        const explicitContainer = explicitUrlContainer(safeUrl);
        const parsedContainer =
          hit.container && hit.container !== "unknown"
            ? hit.container
            : undefined;
        const metadataConflict =
          explicitContainer &&
          parsedContainer &&
          explicitContainer !== parsedContainer;
        if (
          metadataConflict ||
          effectiveContainer === "mkv" ||
          effectiveContainer === "webm"
        ) {
          await invalidateTrustedFastCachedStream(trustKey);
          return {
            hit,
            safeUrl,
            validation: {
              acceptable: false,
              reason: "unsupported_container" as const,
              totalBytes: validation.totalBytes,
              status: validation.status,
              elapsedMs: validation.elapsedMs,
            },
          };
        }

        const containerValidation = await validateNativeBrowserContainer(
          safeUrl,
          validationTimeoutMs
        );
        if (containerValidation.acceptable && containerValidation.container) {
          const normalizedHit: CachedStreamRecord = {
            ...hit,
            url: safeUrl,
            container: containerValidation.container,
          };
          await upsertCachedStream(
            {
              ...keyBase,
              quality: slot,
              provider: "realdebrid",
            },
            normalizedHit
          );
          if (
            validation.reason === "plausible_size" &&
            normalizedHit.codec === "h264"
          ) {
            await upsertTrustedFastCachedStream(trustKey, normalizedHit);
          } else {
            await invalidateTrustedFastCachedStream(trustKey);
          }
          return { hit: normalizedHit, safeUrl, validation };
        }

        await invalidateTrustedFastCachedStream(trustKey);
        if (
          containerValidation.reason !== "network_indeterminate" ||
          (effectiveContainer !== "mp4" && effectiveContainer !== "mov")
        ) {
          return {
            hit,
            safeUrl,
            validation: {
              acceptable: false,
              reason: "unsupported_container" as const,
              totalBytes: validation.totalBytes,
              status: containerValidation.status,
              elapsedMs:
                validation.elapsedMs + containerValidation.elapsedMs,
            },
          };
        }
      } else {
        await invalidateTrustedFastCachedStream(trustKey);
      }
      return { hit, safeUrl, validation };
    })
  );
  const hits: PlaybackSource[] = [];
  const missing: DebridSlot[] = [];
  const occupiedIdentities = new Set<string>();
  const invalidations: Promise<void>[] = [];
  RD_SLOTS.forEach((slot, i) => {
    const { hit, safeUrl, validation } = validatedBySlot[i] ?? {};
    const identities = hit && safeUrl ? cachedIdentities(hit, safeUrl) : [];
    const duplicatesExistingHit = identities.some((identity) => occupiedIdentities.has(identity));
    if (hit && safeUrl && validation?.acceptable && !duplicatesExistingHit) {
      identities.forEach((identity) => occupiedIdentities.add(identity));
      hits.push(
        toRdPlaybackSource(
          slot,
          keyBase.imdbId,
          keyBase.mediaType,
          keyBase.season,
          keyBase.episode,
          { ...hit, url: safeUrl },
          hit.codec,
          hit.container
        )
      );
    } else {
      missing.push(slot);
      if (hit && validation && !validation.acceptable) {
        logRejectedRdMedia(hit, validation, keyBase.mediaType, "cache", keyBase.imdbId, slot);
        invalidations.push(
          Promise.all([
            invalidateCachedStream({ ...keyBase, quality: slot, provider: "realdebrid" }),
            invalidateTrustedFastCachedStream({ ...keyBase, tmdbId, quality: slot }),
          ]).then(() => undefined)
        );
      }
      if (hit && validation?.acceptable && duplicatesExistingHit) {
        console.warn(
          JSON.stringify({
            event: "debrid_duplicate_slot_rejected",
            provider: "realdebrid",
            mediaType: keyBase.mediaType,
            imdbId: keyBase.imdbId,
            slot,
            title: hit.title,
          })
        );
        invalidations.push(
          Promise.all([
            invalidateCachedStream({ ...keyBase, quality: slot, provider: "realdebrid" }),
            invalidateTrustedFastCachedStream({ ...keyBase, tmdbId, quality: slot }),
          ]).then(() => undefined)
        );
      }
    }
  });

  // 720p is an availability fallback, not a sixth eagerly-filled quality
  // rung. If a native 4K/1080p source is already healthy, an empty fallback
  // slot must not make an otherwise warm roster hit Torrentio again.
  const hasHigherNative = hits.some(
    (source) =>
      source.compat === "native" &&
      typeof source.maxHeight === "number" &&
      source.maxHeight >= 1080
  );
  if (hasHigherNative) {
    const fallbackIndex = missing.indexOf("native-720");
    if (fallbackIndex >= 0) missing.splice(fallbackIndex, 1);
  }

  await Promise.all(invalidations);
  return { hits, missing, occupiedIdentities };
}

/**
 * Cache-first resolve of the entire RD roster. Reads whatever's cached,
 * fetches (or reuses) Torrentio candidates only if something's still
 * missing, then resolves every missing slot concurrently (bounded by
 * `RESOLVE_CONCURRENCY`) within one shared `RD_FULL_DEADLINE_MS` deadline.
 * Returns the candidates it fetched/used too, so a caller (the fast path's
 * background fill) that already paid for a Torrentio fetch can reuse it
 * instead of hitting Torrentio twice for the same request.
 */
async function resolveRealDebridSlots(
  keyBase: KeyBase,
  req: ResolveDebridSourcesRequest,
  rdToken: string,
  preFetchedCandidates?: DebridCandidate[]
): Promise<{ sources: PlaybackSource[]; candidates: DebridCandidate[] }> {
  const { hits, missing, occupiedIdentities } = await readCachedRdSlots(
    keyBase,
    rdToken,
    req.tmdbId
  );
  if (!missing.length) return { sources: hits, candidates: preFetchedCandidates ?? [] };

  const deadline = Date.now() + RD_FULL_DEADLINE_MS;
  const candidates =
    preFetchedCandidates ??
    (await fetchTorrentioCandidates({
      imdbId: keyBase.imdbId,
      mediaType: req.mediaType,
      season: req.season,
      episode: req.episode,
      rdToken,
    }));

  const slotOptions = buildRdSlotOptions(candidates, missing, occupiedIdentities);
  const native1080Slots = missing.filter((slot) =>
    slot.startsWith("native-1080")
  );
  const rankedNative1080 =
    native1080Slots.length > 0
      ? await resolveRankedCandidatePool(
          slotOptions[native1080Slots[0]!] ?? [],
          native1080Slots.length,
          rdToken,
          deadline,
          req.mediaType,
          occupiedIdentities
        )
      : [];
  const nativeEntries = rankedNative1080.map((resolved, index) => ({
    slot: native1080Slots[index]!,
    resolved,
  }));

  // A successful native 1080p roster makes the 720p availability fallback
  // redundant. Do not eagerly resolve/cache a sixth, lower-quality source.
  const otherMissing = missing.filter(
    (slot) =>
      !slot.startsWith("native-1080") &&
      !(slot === "native-720" && nativeEntries.length > 0)
  );
  const otherEntries = await mapWithConcurrency(otherMissing, RESOLVE_CONCURRENCY, async (slot) => {
    const options = slotOptions[slot];
    if (!options?.length) return null;
    const resolved = await resolveSlotCandidate(
      options,
      rdToken,
      deadline,
      req.mediaType,
      occupiedIdentities
    );
    return resolved ? { slot, resolved } : null;
  });
  let resolvedPerSlot = [...nativeEntries, ...otherEntries].filter(
    (entry): entry is { slot: DebridSlot; resolved: ResolvedCandidate } =>
      entry !== null
  );

  // If a native 4K source resolved while 1080p was absent, it also supersedes
  // a simultaneously resolved 720p fallback before anything is persisted.
  const hasHigherNative =
    hits.some(
      (source) =>
        source.compat === "native" &&
        typeof source.maxHeight === "number" &&
        source.maxHeight >= 1080
    ) ||
    resolvedPerSlot.some(
      (entry) =>
        entry.slot === "native-2160" ||
        entry.slot.startsWith("native-1080")
    );
  if (hasHigherNative) {
    resolvedPerSlot = resolvedPerSlot.filter(
      (entry) => entry.slot !== "native-720"
    );
  }
  resolvedPerSlot.sort(
    (a, b) => RD_SLOTS.indexOf(a.slot) - RD_SLOTS.indexOf(b.slot)
  );

  const newSources: PlaybackSource[] = [];
  for (const entry of resolvedPerSlot) {
    if (!entry) continue;
    const { slot, resolved } = entry;
    // Hard invariant, re-applied right before this URL can become a
    // PlaybackSource or a CachedStream row: `resolveCandidateLink` already
    // only returns sanitized URLs, but this is the single choke point every
    // final RD URL in this module must pass through — fail safe (drop the
    // slot) rather than ever cache or return a token-bearing link.
    const safeUrl = sanitizeStreamUrl(resolved.directUrl, rdToken);
    if (!safeUrl) continue;
    const effectiveContainer = effectiveReleaseContainer(
      safeUrl,
      resolved.container
    );
    const record: CachedStreamRecord = {
      title: resolved.title,
      source: resolved.infoHash ?? safeUrl,
      url: safeUrl,
      compat: resolved.compat,
      ...(resolved.codec ? { codec: resolved.codec } : {}),
      ...(effectiveContainer ? { container: effectiveContainer } : {}),
    };
    await upsertCachedStream({ ...keyBase, quality: slot, provider: "realdebrid" }, record);
    const trustKey = { ...keyBase, tmdbId: req.tmdbId, quality: slot };
    if (resolved.fastTrusted) {
      await upsertTrustedFastCachedStream(trustKey, record);
    } else {
      await invalidateTrustedFastCachedStream(trustKey);
    }
    newSources.push(
      toRdPlaybackSource(
        slot,
        keyBase.imdbId,
        keyBase.mediaType,
        keyBase.season,
        keyBase.episode,
        record,
        resolved.codec,
        effectiveContainer
      )
    );
  }

  return { sources: [...hits, ...newSources], candidates };
}

/**
 * FAST PATH — one versioned, short-lived SQLite trust lookup keyed directly
 * by TMDB id. Full resolution writes this separate namespace only after the
 * final token-free object proves plausible size + ISO-BMFF and is explicitly
 * H.264/native. Legacy normal-cache rows can therefore never become fast hits.
 *
 * This function must remain pure DB/local computation: no TMDB lookup, CDN
 * probe, provider construction, Torrentio/RD request, or background work.
 * The client already starts a separate full request which owns enrichment.
 */
async function resolveFastBestNativeFromCache(req: ResolveDebridSourcesRequest): Promise<PlaybackSource[]> {
  const season = req.season ?? 0;
  const episode = req.episode ?? 0;
  const rdToken = process.env.REAL_DEBRID_API_TOKEN as string;
  const hits = await getTrustedFastCachedStreams({
    tmdbId: req.tmdbId,
    mediaType: req.mediaType,
    season,
    episode,
  });
  const slotOrder = new Map(RD_SLOTS.map((slot, index) => [slot, index]));
  const seenUrls = new Set<string>();
  const sources: PlaybackSource[] = [];

  for (const hit of hits.sort(
    (a, b) =>
      (slotOrder.get(a.quality) ?? Number.MAX_SAFE_INTEGER) -
      (slotOrder.get(b.quality) ?? Number.MAX_SAFE_INTEGER)
  )) {
    const safeUrl = sanitizeStreamUrl(hit.url, rdToken);
    if (!safeUrl || seenUrls.has(safeUrl)) continue;
    const explicitContainer = explicitUrlContainer(safeUrl);
    const effectiveContainer = effectiveReleaseContainer(safeUrl, hit.container);
    const containerConflict =
      explicitContainer &&
      hit.container &&
      hit.container !== "unknown" &&
      explicitContainer !== hit.container;
    if (
      containerConflict ||
      hit.compat !== "native" ||
      hit.codec !== "h264" ||
      (effectiveContainer !== "mp4" && effectiveContainer !== "mov")
    ) {
      continue;
    }
    seenUrls.add(safeUrl);
    sources.push(
      toRdPlaybackSource(
        hit.quality,
        hit.imdbId,
        req.mediaType,
        season,
        episode,
        { ...hit, url: safeUrl },
        hit.codec,
        effectiveContainer
      )
    );
  }
  return sources;
}

/**
 * Fast/prefetch-path entry point — see the module header and
 * `resolveFastBestNativeFromCache`. Cache-only: the awaited path is bounded
 * to `RD_FAST_DEADLINE_MS` (a defensive backstop over one bounded
 * `CachedStream` DB query — no live network call is ever on this path) via
 * `Promise.race`, so RD can NEVER delay the fast TTFF
 * response — on a cache miss (or the read somehow missing even that budget)
 * this resolves to `[]` and route.ts falls through to its normal provider
 * path. The client's independent full request owns roster enrichment.
 * TorBox is intentionally NOT attempted on the fast path at all — its
 * add/poll/requestdl flow is both too slow for a TTFF budget and too quota-
 * constrained to spend on a request that may be a discarded prefetch.
 */
export async function resolveFastDebridSources(
  req: ResolveDebridSourcesRequest
): Promise<PlaybackSource[]> {
  if (!isRealDebridConfigured()) return [];
  const core = resolveFastBestNativeFromCache(req).catch(() => [] as PlaybackSource[]);
  const timeout = new Promise<PlaybackSource[]>((resolve) => {
    setTimeout(() => resolve([]), RD_FAST_DEADLINE_MS);
  });
  return Promise.race([core, timeout]);
}

// ---------------------------------------------------------------------------
// TorBox sibling tier (unchanged quota-bounded 2-row-per-title model)
// ---------------------------------------------------------------------------

/** Prefer native (browser-safe H.264) over Safari-only HEVC/HDR at the same resolution. */
function rankCachedTorboxForHeight(candidates: DebridCandidate[], height: 1080 | 2160): DebridCandidate[] {
  return candidates
    .filter((c) => c.resolutionHeight === height && Boolean(c.infoHash))
    .sort((a, b) => (a.compat === "native" ? 0 : 1) - (b.compat === "native" ? 0 : 1));
}

/**
 * Turn a resolved TorBox file into a `ResolvedCandidate`, merging the codec/
 * compat classified from the ACTUAL TorBox file name with the Torrentio
 * candidate's own classification so the result never UNDER-flags a
 * Safari-only release as natively playable (if either says "safari", it's
 * "safari"). Runs the URL through `sanitizeTorboxStreamUrl` — returns null
 * if it can't be reduced to a safe, token-free link.
 */
function toResolvedTorbox(
  candidate: DebridCandidate,
  file: TorboxResolvedFile,
  apiKey: string
): ResolvedCandidate | null {
  const safeUrl = sanitizeTorboxStreamUrl(file.url, apiKey);
  if (!safeUrl) return null;
  const compat: ReleaseCompat =
    candidate.compat === "safari" || file.compat === "safari" ? "safari" : "native";
  const codec = file.codec !== "unknown" ? file.codec : candidate.codec;
  return { ...candidate, compat, codec, directUrl: safeUrl };
}

/** Cache-first read for one provider/quality set (TorBox's 2-row-per-title model) — a row that fails its sanitizer is treated as a miss, never handed to a client. */
async function readCachedSources(
  provider: DebridProvider,
  keyBase: KeyBase,
  sanitize: (url: string) => string | null
): Promise<{ hits: PlaybackSource[]; missing: DebridQuality[] }> {
  const cachedByQuality = await Promise.all(
    QUALITIES.map((quality) => getFreshCachedStream({ ...keyBase, quality, provider }))
  );
  const hits: PlaybackSource[] = [];
  const missing: DebridQuality[] = [];
  QUALITIES.forEach((quality, i) => {
    const hit = cachedByQuality[i];
    const safeUrl = hit ? sanitize(hit.url) : null;
    if (hit && safeUrl) {
      hits.push(
        toPlaybackSource(provider, quality, keyBase.imdbId, keyBase.mediaType, keyBase.season, keyBase.episode, {
          ...hit,
          url: safeUrl,
        })
      );
    } else {
      missing.push(quality);
    }
  });
  return { hits, missing };
}

/**
 * Orchestrates the PREMIUM debrid tier for one title/episode: Real-Debrid's
 * full roster and TorBox resolved side by side, cached independently (see
 * cached-stream.ts) so repeat views are instant and don't re-hit
 * Torrentio/RD/TorBox. Only ever called from the FULL playback resolve path
 * (never `fast` — see `resolveFastDebridSources` for that) — see
 * src/app/api/playback/[type]/[id]/route.ts. Either provider missing its own
 * token simply contributes zero sources; a failure in one never affects the
 * other.
 */
export async function resolveDebridSources(
  req: ResolveDebridSourcesRequest
): Promise<PlaybackSource[]> {
  const rdConfigured = isRealDebridConfigured();
  const torboxConfigured = isTorBoxConfigured();
  if (!rdConfigured && !torboxConfigured) return [];

  try {
    const imdbId = await resolveImdbId(req.tmdbId, req.mediaType);
    if (!imdbId) return [];

    const season = req.season ?? 0;
    const episode = req.episode ?? 0;
    const keyBase: KeyBase = { imdbId, mediaType: req.mediaType, season, episode };

    const sources: PlaybackSource[] = [];
    let rdCandidates: DebridCandidate[] = [];

    if (rdConfigured) {
      if (req.forceRefresh) {
        // A server-side range probe can pass while an old signed CDN URL later
        // fails in the browser. Roster exhaustion is stronger evidence than
        // cache age, so expire every RD slot and obtain fresh unrestrict links.
        await Promise.all(
          RD_SLOTS.flatMap((slot) => [
            invalidateCachedStream({
              ...keyBase,
              quality: slot,
              provider: "realdebrid",
            }),
            invalidateTrustedFastCachedStream({
              ...keyBase,
              tmdbId: req.tmdbId,
              quality: slot,
            }),
          ])
        );
      }
      const rdToken = process.env.REAL_DEBRID_API_TOKEN as string;
      const { sources: rdSources, candidates } = await resolveRealDebridSlots(keyBase, req, rdToken);
      sources.push(...rdSources);
      rdCandidates = candidates;
    }

    if (torboxConfigured) {
      const torboxKey = process.env.TORBOX_API_KEY as string;
      const { hits, missing: torboxMissing } = await readCachedSources("torbox", keyBase, (url) =>
        sanitizeTorboxStreamUrl(url, torboxKey)
      );
      sources.push(...hits);

      if (torboxMissing.length) {
        // TorBox needs only raw infoHashes. Reuse the RD-configured list's
        // hashes when we already have them (provider-agnostic — saves a
        // fetch); otherwise scrape Torrentio's UN-configured (no-debrid)
        // endpoint. Either way the TorBox key is NEVER placed in a Torrentio
        // request — this is what lets TorBox's free tier work with NO
        // Real-Debrid configured at all.
        const torboxSourceCandidates = rdCandidates.length
          ? rdCandidates
          : await fetchTorrentioCandidatesNoDebrid({
              imdbId,
              mediaType: req.mediaType,
              season: req.season,
              episode: req.episode,
            });

        // ONE absolute deadline for the ENTIRE TorBox resolve — checkCached
        // plus every createtorrent/poll/requestdl below share it (each
        // call's timeout is clamped to the time remaining), so the whole
        // tier can't exceed TORBOX_TOTAL_POLL_BUDGET_MS no matter how many
        // steps run.
        const deadline = torboxDeadlineFromNow();

        const hashes = torboxSourceCandidates
          .map((c) => c.infoHash)
          .filter((h): h is string => Boolean(h));
        const cachedHashes = hashes.length ? await checkCachedTorboxHashes(hashes, deadline) : new Set<string>();
        const cachedCandidates = torboxSourceCandidates.filter(
          (c) => c.infoHash && cachedHashes.has(c.infoHash.toLowerCase())
        );

        if (cachedCandidates.length) {
          // QUOTA-CRITICAL — do NOT createtorrent for every cached release.
          // Rank per quality tier WITHOUT network, then add+poll+requestdl
          // for ONLY the winner(s): at most one add per surfaced quality,
          // capped at MAX_TORBOX_ADDS_PER_LOOKUP total across tiers +
          // fallbacks. A torrent already resolved for one tier is reused for
          // the other (no 2nd add).
          const resolvedByHash = new Map<string, TorboxResolvedFile | null>();
          let addsRemaining = MAX_TORBOX_ADDS_PER_LOOKUP;

          for (const quality of torboxMissing) {
            for (const cand of rankCachedTorboxForHeight(cachedCandidates, heightForQuality(quality))) {
              const hash = cand.infoHash!.toLowerCase();
              let file = resolvedByHash.get(hash);
              if (file === undefined) {
                if (addsRemaining <= 0 || Date.now() >= deadline) break;
                addsRemaining--;
                file = await resolveTorboxDirectLink(cand.infoHash!, deadline);
                resolvedByHash.set(hash, file);
              }
              if (!file) continue; // this candidate failed — try the next ranked one, still within the add cap
              const resolvedCandidate = toResolvedTorbox(cand, file, torboxKey);
              if (!resolvedCandidate) continue;
              const record: CachedStreamRecord = {
                title: resolvedCandidate.title,
                source: resolvedCandidate.infoHash ?? resolvedCandidate.directUrl,
                url: resolvedCandidate.directUrl,
                compat: resolvedCandidate.compat,
              };
              const codec =
                resolvedCandidate.codec === "hevc" || resolvedCandidate.codec === "h264"
                  ? resolvedCandidate.codec
                  : "unknown";
              sources.push(
                toPlaybackSource("torbox", quality, imdbId, req.mediaType, season, episode, record, codec)
              );
              await upsertCachedStream({ ...keyBase, quality, provider: "torbox" }, record);
              break; // this quality tier is satisfied
            }
          }
        }
      }
    }

    return sources;
  } catch {
    return [];
  }
}
