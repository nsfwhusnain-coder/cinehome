/**
 * Thin Real-Debrid client for the PREMIUM debrid tier.
 *
 * IMPORTANT — `/torrents/instantAvailability` is DEPRECATED (returns empty
 * since 2024). We never architect around it. The RD-configured Torrentio
 * request (torrentio.ts) is the PREFERRED cache-detection path — it does the
 * add/select/cache-check server-side and only surfaces already-cached
 * streams. This module is the FALLBACK resolver (path b) for any raw
 * infoHash Torrentio didn't resolve itself: add magnet -> select the largest
 * video file -> poll with a SHORT budget (~1.5s) -> unrestrict if (and only
 * if) it's already `"downloaded"`. We never wait on an uncached torrent —
 * if it isn't ready within the short budget we treat it as not instantly
 * available and skip it.
 *
 * Token is read ONLY from `process.env.REAL_DEBRID_API_TOKEN`. Never logged,
 * never embedded in anything that reaches the client. Every function here
 * no-ops (returns null/[]) when the token is unset or a call fails — this
 * tier must never throw out of the module.
 */

const RD_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_TIMEOUT_MS = 8_000;
/** Short cache-detection budget — never block playback on an uncached download. */
const POLL_BUDGET_MS = 1_500;
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 3;
/**
 * Rate-limit-aware bounded concurrency when resolving multiple candidates.
 * Raised from 3: the rich multi-slot roster (index.ts) resolves up to 5 RD
 * slots per request, and the PREFERRED resolve path for a premium account
 * (`resolveTokenFreeRedirect` following Torrentio's own pre-resolved link) is
 * a cheap redirect-follow — no body read, no RD add/select/poll — so 5-way
 * concurrency stays well inside a premium account's rate limit even though
 * it's ~5x this module's old value.
 */
export const RESOLVE_CONCURRENCY = 5;

const TERMINAL_FAILURE_STATUSES = new Set(["error", "magnet_error", "virus", "dead"]);
const VIDEO_EXT_PATTERN = /\.(mp4|mkv|avi|mov|m4v|webm)$/i;
const NON_FEATURE_FILE_PATTERN =
  /\b(?:featurettes?|bonus(?:es)?|extras?|sample|soundtrack|deleted[ ._-]?scenes?)\b/i;
/** Smaller than a real episode — samples, NFO-side dumps, fake RD cache rows. */
const MIN_FEATURE_FILE_BYTES = 15 * 1024 * 1024;
const RELEASE_STOP_TOKENS = new Set([
  "1080p",
  "2160p",
  "720p",
  "480p",
  "4k",
  "uhd",
  "hdr",
  "hdr10",
  "dv",
  "dovi",
  "bluray",
  "blu",
  "ray",
  "web",
  "webdl",
  "webrip",
  "hdtv",
  "remux",
  "hybrid",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "av1",
  "aac",
  "dts",
  "truehd",
  "atmos",
  "eac3",
  "ac3",
  "ddp",
  "flac",
  "opus",
  "multi",
  "dual",
  "audio",
  "video",
  "sample",
  "proof",
  "proper",
  "repack",
  "internal",
  "extended",
  "unrated",
  "directors",
  "cut",
  "the",
  "and",
  "of",
  "for",
  "mkv",
  "mp4",
  "avi",
  "mov",
  "m4v",
  "webm",
]);

export interface DebridTorrentFile {
  id: number;
  path: string;
  bytes: number;
  selected?: number;
}

interface RdTorrentFile extends DebridTorrentFile {
  selected: number;
}

interface RdTorrentInfo {
  id: string;
  status: string;
  files?: RdTorrentFile[];
  links?: string[];
}

interface RdAddMagnetResponse {
  id: string;
  uri?: string;
}

interface RdUnrestrictResponse {
  download?: string;
  filename?: string;
  filesize?: number;
  mimeType?: string;
}

export function isRealDebridConfigured(): boolean {
  return Boolean(getToken());
}

function getToken(): string | null {
  return process.env.REAL_DEBRID_API_TOKEN || null;
}

async function rdFetch<T>(path: string, token: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${RD_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(RD_TIMEOUT_MS),
    });
    if (!res.ok || res.status === 204) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function formBody(fields: Record<string, string>): { body: URLSearchParams; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

/** Unrestrict any Real-Debrid hoster link (or raw magnet the account already owns) to a direct download URL. */
export async function unrestrictLink(rdOrHosterLink: string): Promise<string | null> {
  const token = getToken();
  if (!token || !rdOrHosterLink) return null;
  const { body, headers } = formBody({ link: rdOrHosterLink });
  const result = await rdFetch<RdUnrestrictResponse>("/unrestrict/link", token, {
    method: "POST",
    body,
    headers,
  });
  return result?.download || null;
}

function tokenizeRelease(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !RELEASE_STOP_TOKENS.has(token));
}

/**
 * Pick the torrent file Torrentio meant — never "largest video" in a pack.
 * fileIdx (0-based) wins when it lands. Otherwise match filename tokens from
 * the release title. A multi-video torrent with no unique match is skipped.
 */
function isUsableFeatureFile(file: DebridTorrentFile): boolean {
  if (NON_FEATURE_FILE_PATTERN.test(file.path)) return false;
  if (Number.isFinite(file.bytes) && file.bytes > 0 && file.bytes < MIN_FEATURE_FILE_BYTES) {
    return false;
  }
  return true;
}

export function pickDebridVideoFile(
  files: readonly DebridTorrentFile[] | undefined,
  opts: { fileIdx?: number; releaseTitle?: string } = {}
): DebridTorrentFile | null {
  if (!files?.length) return null;

  if (typeof opts.fileIdx === "number") {
    const fileIdx = opts.fileIdx;
    const matched = files.find((file) => file.id === fileIdx + 1);
    if (matched && isUsableFeatureFile(matched)) return matched;
  }

  const videos = files.filter((file) => VIDEO_EXT_PATTERN.test(file.path));
  const features = videos.filter(isUsableFeatureFile);
  const pool = features.length ? features : videos.length ? videos : [...files];
  if (pool.length === 1) return pool[0] ?? null;

  const titleTokens = tokenizeRelease(opts.releaseTitle ?? "");
  if (!titleTokens.length) return null;

  let best: DebridTorrentFile | null = null;
  let bestScore = 0;
  let ties = 0;
  for (const file of pool) {
    const fileTokens = new Set(tokenizeRelease(file.path));
    const score = titleTokens.reduce(
      (count, token) => count + (fileTokens.has(token) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = file;
      bestScore = score;
      ties = 1;
    } else if (score === bestScore && score > 0) {
      ties += 1;
    }
  }
  if (!best || bestScore === 0 || ties > 1) return null;
  return best;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Path (b): add a magnet from an infohash, select the file Torrentio named
 * (`fileIdx` or release-title tokens — never "largest in a pack"), then poll
 * RD for a SHORT budget. Only resolves when the torrent is already
 * `"downloaded"` within that budget — otherwise returns null so the caller
 * skips this candidate rather than waiting on a cold download.
 */
export async function resolveDebridDirectLink(
  infoHash: string,
  fileIdx?: number,
  releaseTitle?: string
): Promise<string | null> {
  const token = getToken();
  if (!token || !infoHash) return null;

  try {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    const addBody = formBody({ magnet });
    const added = await rdFetch<RdAddMagnetResponse>("/torrents/addMagnet", token, {
      method: "POST",
      body: addBody.body,
      headers: addBody.headers,
    });
    if (!added?.id) return null;

    let info = await rdFetch<RdTorrentInfo>(`/torrents/info/${added.id}`, token);
    if (!info) return null;

    // Torrentio's fileIdx is 0-based; RD's file `id` is 1-based. A miss
    // tries the release title. A multi-video pack with no unique match is
    // skipped — never "largest file", which is often a different movie.
    const targetFile = pickDebridVideoFile(info.files, { fileIdx, releaseTitle });
    if (!targetFile) return null;
    const selectBody = formBody({ files: String(targetFile.id) });
    await rdFetch(`/torrents/selectFiles/${added.id}`, token, {
      method: "POST",
      body: selectBody.body,
      headers: selectBody.headers,
    });

    const deadline = Date.now() + POLL_BUDGET_MS;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      info = await rdFetch<RdTorrentInfo>(`/torrents/info/${added.id}`, token);
      if (!info) return null;
      if (info.status === "downloaded") break;
      if (TERMINAL_FAILURE_STATUSES.has(info.status)) return null;
      if (Date.now() >= deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (!info || info.status !== "downloaded" || !info.links?.length) {
      // Not instantly available within the short budget — skip, never wait
      // on an uncached torrent to finish downloading.
      return null;
    }

    return await unrestrictLink(info.links[0]!);
  } catch {
    return null;
  }
}

/** Bounded-concurrency map — keeps RD calls rate-limit-aware when resolving several candidates. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
