/**
 * Thin TorBox client for the PREMIUM debrid tier — sibling to realdebrid.ts.
 *
 * VERIFIED against TorBox's live OpenAPI spec (`https://api.torbox.app/openapi.json`,
 * fetched directly — the rendered docs site at api-docs.torbox.app is a JS SPA
 * that doesn't expose endpoint bodies to a plain fetch) and the official
 * `TorBox-App/torbox-sdk-js` model definitions (GitHub, same org as the API).
 * Do NOT trust any orchestration-doc guess at these paths — this is the real
 * surface as of the verification date on this module.
 *
 *   Base:        https://api.torbox.app/v1/api          (NOT "/1.0/api")
 *   Auth:        `Authorization: Bearer <TORBOX_API_KEY>` header — EXCEPT
 *                `requestdl`, whose OpenAPI operation carries no `security`
 *                block at all; it authorizes via a required `token` QUERY
 *                param instead (by design — the returned/request URL is
 *                meant to be usable as a bare redirect, e.g. pasted into a
 *                player, with no custom headers).
 *   checkcached: POST /torrents/checkcached  body {hashes: string[]}
 *                query `format=object` -> { success, data: { [hash]: {...} } }
 *                Genuinely works for cache detection (unlike RD's deprecated
 *                instantAvailability) — this is our short-circuit: only
 *                hashes present as keys in `data` are treated as cached.
 *   createtorrent: POST /torrents/createtorrent (multipart/form-data)
 *                fields verified from the OpenAPI request schema: magnet,
 *                file, seed, allow_zip, name, as_queued, add_only_if_cached.
 *                -> { success, data: { torrent_id, hash, ... } }
 *   mylist:      GET /torrents/mylist?id=<id>&bypass_cache=true
 *                -> { success, data: [{ id, hash, name, size, files,
 *                     download_finished, download_present, download_state }] }
 *                ASSUMED (not confirmed by the spec's response schema, which
 *                is untyped `{}`): readiness = download_finished === true OR
 *                download_present === true. The exact `download_state`
 *                string enum for an instantly-cached TorBox torrent isn't
 *                documented anywhere we could verify — we deliberately don't
 *                branch on that string.
 *   requestdl:   GET /torrents/requestdl?token=&torrent_id=&file_id=&redirect=false
 *                -> { success, data: "<url>" }. Verified via the SDK's
 *                `RequestDownloadLinkOkResponse` model: `data` is a plain
 *                string URL. Believed (not independently confirmed against a
 *                live account) to already be a token-free CDN link — we
 *                never trust that blindly, see token-safety.ts.
 *
 * HONESTY — TorBox's FREE plan (verified verbatim from
 * https://support.torbox.app/en/articles/9836418-account-restrictions,
 * dateModified 2026-01-28) is far more restrictive than "just a 10GB cap":
 *   - 1 torrent add every 24 hours (cooldown)
 *   - 1 active download at a time
 *   - 10 torrent adds PER MONTH total (resets on the 1st)
 *   - 10GB max torrent size (10GiB ~= 11GB is already over — stay under)
 *   - never seeds; "no private torrents at all" (not even leeching)
 *   - no web downloads / Usenet
 * It is UNCONFIRMED whether an `add_only_if_cached` create call against an
 * already-cached hash burns the 24h cooldown / monthly-10 allowance the same
 * as a real new download — the docs don't say. We pre-filter with
 * `checkCachedTorboxHashes` (a pure lookup) before ever calling
 * createtorrent, but every fresh (non-cache-hit) title resolve on this tier
 * still calls createtorrent at least once. If that consumes the free
 * allowance even for cache hits, TorBox free is usable for only ~10 distinct
 * titles a month. THE OWNER'S LIVE TOKEN IS THE ONLY SOURCE OF TRUTH HERE —
 * this module is built correct-and-defensive either way, never fabricated as
 * "just works."
 *
 * LATENCY — every network step (checkcached, createtorrent, poll, requestdl)
 * takes a single absolute `deadline` (epoch ms) threaded from the caller, and
 * each fetch's own timeout is clamped to the time remaining before it. So the
 * WHOLE TorBox resolve is bounded by one wall-clock budget
 * (`TORBOX_TOTAL_POLL_BUDGET_MS`) — not `~15s × (number of steps)`. Past the
 * deadline every function returns null/empty immediately without another
 * request. The orchestrator (index.ts) additionally caps how many
 * createtorrent calls a single lookup may make (quota protection) — this
 * module never decides that.
 *
 * Token is read ONLY from `process.env.TORBOX_API_KEY`. Never logged, never
 * embedded in anything that reaches the client. Every function here no-ops
 * (returns null/[]/empty Set) when the token is unset or a call fails — this
 * tier must never throw out of the module, exactly like realdebrid.ts.
 */

import { parseReleaseTitle, type ReleaseCodec, type ReleaseCompat } from "./torrentio";

const TORBOX_BASE = "https://api.torbox.app/v1/api";
/** Per-call ceiling; each call's real timeout is min(this, time left to the shared deadline). */
const TORBOX_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 750;

/** Poll cadence + total wall-clock budget for the WHOLE resolve (not per candidate) — never block playback on TorBox provisioning a cached torrent. */
export const TORBOX_POLL_INTERVAL_MS = 3_000;
export const TORBOX_TOTAL_POLL_BUDGET_MS = 25_000;

/** Convenience: a fresh absolute deadline `TORBOX_TOTAL_POLL_BUDGET_MS` from now. */
export function torboxDeadlineFromNow(): number {
  return Date.now() + TORBOX_TOTAL_POLL_BUDGET_MS;
}

/** Only browser-playable containers for direct <video> progressive playback. */
const VIDEO_EXT_PATTERN = /\.(mp4|mkv|webm)$/i;

/** TorBox free-tier torrent size cap is documented as 10GB (10GiB ≈ 11GB is already over) — stay safely under. */
const FREE_TIER_MAX_FILE_BYTES = 9.5 * 1024 * 1024 * 1024;

interface TorboxFile {
  id: number;
  name: string;
  size: number;
  mimetype?: string;
  short_name?: string;
}

interface TorboxListEntry {
  id: number;
  hash?: string;
  name?: string;
  size?: number;
  files?: TorboxFile[];
  download_finished?: boolean;
  download_present?: boolean;
  download_state?: string;
}

interface TorboxCheckCachedResponse {
  success?: boolean;
  data?: Record<string, unknown> | unknown[] | null;
}

interface TorboxCreateTorrentResponse {
  success?: boolean;
  data?: { torrent_id?: number; hash?: string } | null;
}

interface TorboxMylistResponse {
  success?: boolean;
  data?: TorboxListEntry[] | TorboxListEntry | null;
}

interface TorboxRequestDlResponse {
  success?: boolean;
  data?: string | null;
}

export interface TorboxResolvedFile {
  url: string;
  fileBytes: number;
  /**
   * Classified from the ACTUAL picked TorBox file name (via
   * `parseReleaseTitle`, reused from torrentio.ts — never re-implemented),
   * not just trusted from Torrentio's release title. The orchestrator
   * (index.ts) merges this with the original Torrentio candidate's own
   * classification and never lets the result under-flag a Safari-only
   * (HEVC/HDR/MKV) release as natively playable.
   */
  codec: ReleaseCodec;
  compat: ReleaseCompat;
}

export function isTorBoxConfigured(): boolean {
  return Boolean(getToken());
}

function getToken(): string | null {
  return process.env.TORBOX_API_KEY || null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Time left before the shared deadline, clamped to the per-call ceiling. 0 (or less) means "no budget — don't fire". */
function effectiveTimeout(deadline: number): number {
  return Math.min(TORBOX_TIMEOUT_MS, deadline - Date.now());
}

/** Whether there's enough budget left to bother with a backoff-and-retry before the deadline. */
function canRetryBefore(deadline: number): boolean {
  return deadline - Date.now() > RETRY_BACKOFF_MS;
}

/**
 * Bearer-header fetch with one retry on 429/5xx (fixed backoff) and a timeout
 * clamped to the time remaining before the shared `deadline`. Returns null
 * immediately (no request) once the deadline has passed. Never throws.
 */
async function torboxFetch<T>(
  path: string,
  token: string,
  deadline: number,
  init?: RequestInit
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = effectiveTimeout(deadline);
    if (timeout <= 0) return null;
    try {
      const res = await fetch(`${TORBOX_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) return (await res.json()) as T;
      if (attempt === 0 && (res.status === 429 || res.status >= 500) && canRetryBefore(deadline)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return null;
    } catch {
      if (attempt === 0 && canRetryBefore(deadline)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Cache-detection short-circuit — genuinely works on TorBox (unlike RD's
 * deprecated instantAvailability). Only hashes that appear as keys in the
 * response's `data` map are treated as cached; anything else (including any
 * failure) is treated as not-cached. Bounded by the shared `deadline`. Never
 * throws.
 */
export async function checkCachedTorboxHashes(
  hashes: string[],
  deadline: number = torboxDeadlineFromNow()
): Promise<Set<string>> {
  const token = getToken();
  const unique = Array.from(new Set(hashes.map((h) => h.toLowerCase()))).filter(Boolean);
  if (!token || !unique.length) return new Set();

  try {
    const res = await torboxFetch<TorboxCheckCachedResponse>(
      "/torrents/checkcached?format=object",
      token,
      deadline,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: unique }),
      }
    );
    if (!res?.success || !res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
      return new Set();
    }
    return new Set(Object.keys(res.data).map((h) => h.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Adds a magnet with `add_only_if_cached: true` — a second, server-side
 * belt-and-suspenders guard on top of `checkCachedTorboxHashes` so we never
 * kick off a real (uncached) download on the free tier even if our cache
 * check was stale. Returns null on any failure or if TorBox declines to add
 * (e.g. because it turned out not to be cached after all). Bounded by the
 * shared `deadline`.
 *
 * QUOTA: this is the ONLY call that consumes a TorBox free-tier torrent add
 * (~10/month). The orchestrator (index.ts) is responsible for calling the
 * resolve flow at most a small constant number of times per lookup — this
 * function never rate-limits itself.
 */
async function addMagnetIfCached(
  infoHash: string,
  token: string,
  deadline: number
): Promise<{ torrentId: number } | null> {
  const form = new FormData();
  form.append("magnet", `magnet:?xt=urn:btih:${infoHash}`);
  form.append("add_only_if_cached", "true");
  form.append("allow_zip", "false");

  const res = await torboxFetch<TorboxCreateTorrentResponse>("/torrents/createtorrent", token, deadline, {
    method: "POST",
    body: form,
  });
  if (!res?.success || !res.data?.torrent_id) return null;
  return { torrentId: res.data.torrent_id };
}

function firstListEntry(data: TorboxMylistResponse["data"]): TorboxListEntry | null {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

/**
 * Polls `mylist` for this torrent id until it looks ready to request a
 * download link for, or the SHARED deadline (across the whole resolve, not
 * per-candidate) passes. Never blocks playback beyond that budget.
 */
async function pollTorrentReady(
  torrentId: number,
  token: string,
  deadline: number
): Promise<TorboxListEntry | null> {
  while (Date.now() < deadline) {
    const res = await torboxFetch<TorboxMylistResponse>(
      `/torrents/mylist?id=${torrentId}&bypass_cache=true`,
      token,
      deadline
    );
    const entry = firstListEntry(res?.data);
    if (entry && (entry.download_finished === true || entry.download_present === true)) {
      return entry;
    }
    if (Date.now() + TORBOX_POLL_INTERVAL_MS >= deadline) break;
    await sleep(TORBOX_POLL_INTERVAL_MS);
  }
  return null;
}

/** Largest browser-playable-container file under the free-tier size guard. */
function pickPlayableFile(files: TorboxFile[] | undefined): TorboxFile | null {
  if (!files?.length) return null;
  const eligible = files.filter(
    (f) => f.name && VIDEO_EXT_PATTERN.test(f.name) && f.size > 0 && f.size <= FREE_TIER_MAX_FILE_BYTES
  );
  if (!eligible.length) return null;
  return eligible.reduce<TorboxFile | null>((best, f) => (f.size > (best?.size ?? -1) ? f : best), null);
}

/**
 * `requestdl` authorizes via a `token` QUERY param (see module header) — no
 * Authorization header, per its OpenAPI operation carrying no `security`
 * block. `redirect=false` so we get JSON back (`data`: the URL string)
 * instead of a 302.
 */
async function requestDownloadLink(
  torrentId: number,
  fileId: number,
  token: string,
  deadline: number
): Promise<string | null> {
  const params = new URLSearchParams({
    token,
    torrent_id: String(torrentId),
    file_id: String(fileId),
    redirect: "false",
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = effectiveTimeout(deadline);
    if (timeout <= 0) return null;
    try {
      const res = await fetch(`${TORBOX_BASE}/torrents/requestdl?${params.toString()}`, {
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const body = (await res.json()) as TorboxRequestDlResponse;
        return body.success && body.data ? body.data : null;
      }
      if (attempt === 0 && (res.status === 429 || res.status >= 500) && canRetryBefore(deadline)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return null;
    } catch {
      if (attempt === 0 && canRetryBefore(deadline)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Full add -> poll -> pick-file -> requestdl flow for ONE already-cache-
 * confirmed infoHash (caller must have already filtered via
 * `checkCachedTorboxHashes` — this function adds its own
 * `add_only_if_cached` guard on top, but never re-checks the cache itself).
 * `deadline` is the single absolute wall-clock budget computed ONCE by the
 * caller and shared across checkCached + every resolve in this lookup — each
 * network step below is clamped to the time remaining before it, so the
 * whole TorBox tier can't exceed that budget. Consumes exactly one TorBox
 * torrent add (the createtorrent inside `addMagnetIfCached`), so the caller
 * MUST rank first and invoke this only for the winner(s) — see index.ts.
 * Never throws; returns null on any failure, timeout, or ineligible file.
 */
export async function resolveTorboxDirectLink(
  infoHash: string,
  deadline: number
): Promise<TorboxResolvedFile | null> {
  const token = getToken();
  if (!token || !infoHash || Date.now() >= deadline) return null;

  try {
    const added = await addMagnetIfCached(infoHash, token, deadline);
    if (!added) return null;

    const entry = await pollTorrentReady(added.torrentId, token, deadline);
    if (!entry) return null;

    const file = pickPlayableFile(entry.files);
    if (!file) return null;

    const url = await requestDownloadLink(added.torrentId, file.id, token, deadline);
    if (!url) return null;

    const parsed = parseReleaseTitle(file.name);
    return { url, fileBytes: file.size, codec: parsed.codec, compat: parsed.compat };
  } catch {
    return null;
  }
}
