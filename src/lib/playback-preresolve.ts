/**
 * Client-side low-priority playback source pre-resolution.
 * Cap 3 concurrent; abort on navigation; skip when saveData.
 */

import { getPlaybackDiscoveryPreferenceKey } from "@/lib/player-preferences";

type Job = {
  url: string;
  key: string;
  abort: AbortController;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  started: boolean;
  finished: boolean;
};

const MAX_PRERESOLVE_CONCURRENCY = 3;
const MAX_PRERESOLVE_QUEUE_ENTRIES = 8;
const PRERESOLVE_TIMEOUT_MS = 10_000;
const queue: Job[] = [];
let active = 0;
const activeJobs = new Set<Job>();
const inFlight = new Map<string, Promise<unknown>>();
interface PlaybackMemoryEntry {
  updatedAt: number;
  expiresAt: number;
  data: unknown;
}
const memory = new Map<string, PlaybackMemoryEntry>();
/** Stay below the server's 3-minute signed-source cache window. */
const PLAYBACK_MEMORY_TTL_MS = 2 * 60 * 1000;
const PLAYBACK_MEMORY_MAX_ENTRIES = 64;
/**
 * Hover debounce before kicking preresolve (cards/home already use 150ms).
 * Exported so UI stays aligned if they import it later.
 */
export const HOVER_PRERESOLVE_DELAY_MS = 150;

function saveData(): boolean {
  try {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return Boolean(c?.saveData);
  } catch {
    return false;
  }
}

function prunePlaybackMemory(now: number): void {
  for (const [key, value] of memory) {
    if (now >= value.expiresAt) memory.delete(key);
  }
  while (memory.size > PLAYBACK_MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) return;
    memory.delete(oldest);
  }
}

function playbackMemoryTtl(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const response = data as {
    status?: unknown;
    partial?: unknown;
    streamUrl?: unknown;
    sources?: Array<{ url?: unknown }>;
  };
  if (response.status !== "available") return null;
  const playable =
    (typeof response.streamUrl === "string" && response.streamUrl.length > 0) ||
    response.sources?.some(
      (source) => typeof source.url === "string" && source.url.length > 0
    );
  if (!playable) return null;
  return PLAYBACK_MEMORY_TTL_MS;
}

function storePlaybackMemory(key: string, data: unknown, ttlMs: number): void {
  const now = Date.now();
  prunePlaybackMemory(now);
  memory.delete(key);
  memory.set(key, { updatedAt: now, expiresAt: now + ttlMs, data });
  prunePlaybackMemory(now);
}

function finishJob(job: Job, continuePumping = true): void {
  if (job.finished) return;
  job.finished = true;
  if (job.timeout) clearTimeout(job.timeout);
  if (job.started) {
    active = Math.max(0, active - 1);
    activeJobs.delete(job);
  }
  if (inFlight.get(job.key) === job.promise) inFlight.delete(job.key);
  if (continuePumping) pump();
}

function runJob(job: Job): void {
  job.timeout = setTimeout(() => job.abort.abort(), PRERESOLVE_TIMEOUT_MS);
  void fetch(job.url, {
    signal: job.abort.signal,
    priority: "low",
  } as RequestInit)
    .then(async (res) => {
      const json = await res.json();
      if (job.finished) return;
      const ttl = res.ok ? playbackMemoryTtl(json) : null;
      if (ttl != null) storePlaybackMemory(job.key, json, ttl);
      job.resolve(json);
    })
    .catch(() => {
      if (!job.finished) job.resolve(null);
    })
    .finally(() => finishJob(job));
}

function pump(): void {
  while (active < MAX_PRERESOLVE_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    job.started = true;
    activeJobs.add(job);
    runJob(job);
  }
}

function dropOldestQueuedJob(): void {
  const stale = queue.shift();
  if (!stale) return;
  stale.abort.abort();
  stale.resolve(null);
  finishJob(stale, false);
}

export function buildPlaybackUrl(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number,
  fast = true
): string {
  const params = new URLSearchParams();
  if (mediaType === "tv") {
    params.set("season", String(season && season > 0 ? season : 1));
    params.set("episode", String(episode && episode > 0 ? episode : 1));
  }
  if (fast) params.set("fast", "1");
  params.set("prefetch", "1");
  // Preferred quality for ranking (client Settings). Safe in browser only.
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem("cinehome:preferred-quality");
      if (raw === "auto" || raw === null || raw === "") {
        params.set("qualityHint", "auto");
      } else {
        const n = Number(raw);
        params.set(
          "qualityHint",
          Number.isFinite(n) && [2160, 1440, 1080, 720, 480, 360].includes(n)
            ? String(n)
            : "auto"
        );
      }
    }
  } catch {
    /* ignore */
  }
  return `/api/playback/${mediaType}/${tmdbId}?${params.toString()}`;
}

export function playbackMemKey(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number,
  discoveryPreference = getPlaybackDiscoveryPreferenceKey()
): string {
  return `${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}:${discoveryPreference}`;
}

export function getMemPlayback(key: string): unknown | null {
  prunePlaybackMemory(Date.now());
  const hit = memory.get(key);
  if (!hit) return null;
  return hit.data;
}

export function getMemPlaybackSeed(
  key: string
): Pick<PlaybackMemoryEntry, "data" | "updatedAt"> | null {
  prunePlaybackMemory(Date.now());
  const hit = memory.get(key);
  return hit ? { data: hit.data, updatedAt: hit.updatedAt } : null;
}

/** Queue a low-priority resolve. Navigation aborts resolve to null. */
export function preresolvePlayback(opts: {
  mediaType: string;
  tmdbId: number;
  season?: number;
  episode?: number;
}): Promise<unknown> {
  if (typeof window === "undefined" || saveData()) {
    return Promise.resolve(null);
  }
  const key = playbackMemKey(opts.mediaType, opts.tmdbId, opts.season, opts.episode);
  const cached = getMemPlayback(key);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const abort = new AbortController();
  const url = buildPlaybackUrl(opts.mediaType, opts.tmdbId, opts.season, opts.episode, true);

  let resolveJob!: (value: unknown) => void;
  const promise = new Promise<unknown>((resolve) => {
    resolveJob = resolve;
  });
  const job: Job = {
    url,
    key,
    abort,
    promise,
    resolve: resolveJob,
    started: false,
    finished: false,
  };
  inFlight.set(key, promise);
  while (queue.length >= MAX_PRERESOLVE_QUEUE_ENTRIES) {
    dropOldestQueuedJob();
  }
  queue.push(job);
  pump();
  return promise;
}

/** Abort all queued + in-flight jobs (call on navigation). */
export function abortAllPreresolve(): void {
  const queued = queue.splice(0);
  for (const job of queued) {
    job.abort.abort();
    job.resolve(null);
    finishJob(job, false);
  }
  for (const job of [...activeJobs]) {
    job.abort.abort();
    job.resolve(null);
    finishJob(job, false);
  }
  pump();
  abortManifestWarmups();
}

export function clearPlaybackPreresolveCache(): void {
  abortAllPreresolve();
  memory.clear();
  recentManifestWarmups.clear();
}

/** Preconnect to stream origin once a source URL is known. */
export function preconnectStreamOrigin(streamUrl: string | null | undefined): void {
  if (!streamUrl || typeof document === "undefined") return;
  try {
    const u = new URL(streamUrl, window.location.origin);
    const origin = u.origin;
    if (document.querySelector(`link[data-preconnect="${origin}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    link.setAttribute("data-preconnect", origin);
    document.head.appendChild(link);
  } catch {
    /* ignore */
  }
}

type ManifestWarmJob = {
  url: string;
  targetHeight: number;
  abort: AbortController;
  finished: boolean;
};

interface HlsVariant {
  url: string;
  height: number;
}

export interface HlsWarmTarget {
  kind: "variant" | "media" | "empty";
  playlistUrl?: string;
  initSegmentUrl?: string;
  segmentUrl?: string;
}

const MANIFEST_WARM_MAX_CONCURRENCY = 1;
const MANIFEST_WARM_QUEUE_MAX_ENTRIES = 4;
const MANIFEST_WARM_MAX_DEPTH = 2;
const MANIFEST_WARM_TIMEOUT_MS = 4_000;
const MANIFEST_WARM_MAX_BYTES = 512 * 1024;
const MANIFEST_WARM_CACHE_TTL_MS = 3 * 60 * 1000;
const MANIFEST_WARM_CACHE_MAX_ENTRIES = 64;
const DEFAULT_MANIFEST_WARM_HEIGHT = 1080;
const manifestWarmQueue: ManifestWarmJob[] = [];
const activeManifestWarmups = new Map<string, ManifestWarmJob>();
const recentManifestWarmups = new Map<string, number>();

function resolveHlsUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function variantHeight(tag: string): number {
  const match = tag.match(/RESOLUTION=\d+x(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function parseHlsVariants(lines: readonly string[], baseUrl: string): HlsVariant[] {
  const variants: HlsVariant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const tag = lines[index]!.trim();
    if (!tag.startsWith("#EXT-X-STREAM-INF:")) continue;
    const uri = lines.slice(index + 1).find((line) => {
      const value = line.trim();
      return value.length > 0 && !value.startsWith("#");
    });
    const url = uri ? resolveHlsUrl(uri.trim(), baseUrl) : null;
    if (url) variants.push({ url, height: variantHeight(tag) });
  }
  return variants;
}

function pickWarmVariant(
  variants: readonly HlsVariant[],
  targetHeight: number
): HlsVariant | null {
  const known = variants.filter((variant) => variant.height > 0);
  if (!known.length) return variants[0] ?? null;
  const atOrAbove = known
    .filter((variant) => variant.height >= targetHeight)
    .sort((a, b) => a.height - b.height);
  if (atOrAbove.length) return atOrAbove[0]!;
  return [...known].sort((a, b) => b.height - a.height)[0] ?? null;
}

function mapUriFromTag(tag: string): string | null {
  const match = tag.match(/URI=(?:"([^"]+)"|([^,\s]+))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

/** Parse by HLS tags, not filename extensions (proxy URLs are extensionless). */
export function selectHlsWarmTarget(
  playlist: string,
  playlistUrl: string,
  targetHeight = DEFAULT_MANIFEST_WARM_HEIGHT
): HlsWarmTarget {
  const lines = playlist.split(/\r?\n/);
  const variant = pickWarmVariant(
    parseHlsVariants(lines, playlistUrl),
    targetHeight
  );
  if (variant) return { kind: "variant", playlistUrl: variant.url };

  const mapTag = lines.find((line) => line.trim().startsWith("#EXT-X-MAP:"));
  const mapUri = mapTag ? mapUriFromTag(mapTag) : null;
  const segment = lines.find((line) => {
    const value = line.trim();
    return value.length > 0 && !value.startsWith("#");
  });
  const initSegmentUrl = mapUri
    ? resolveHlsUrl(mapUri, playlistUrl) ?? undefined
    : undefined;
  const segmentUrl = segment
    ? resolveHlsUrl(segment.trim(), playlistUrl) ?? undefined
    : undefined;
  return initSegmentUrl || segmentUrl
    ? { kind: "media", initSegmentUrl, segmentUrl }
    : { kind: "empty" };
}

function canReadManifestContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("mpegurl") ||
    normalized.startsWith("text/") ||
    normalized.includes("octet-stream")
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedManifest(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MANIFEST_WARM_MAX_BYTES) {
    await cancelResponseBody(response);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MANIFEST_WARM_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWarmManifest(
  playlistUrl: string,
  parentSignal: AbortSignal,
  timeoutMs: number
): Promise<string | null> {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), Math.max(1, timeoutMs));
  try {
    if (parentSignal.aborted) return null;
    const response = await fetch(playlistUrl, {
      signal: abort.signal,
      priority: "low",
    } as RequestInit);
    if (!response.ok || !canReadManifestContentType(response.headers.get("content-type"))) {
      await cancelResponseBody(response);
      return null;
    }
    return await readBoundedManifest(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

async function warmHlsPathUntil(
  playlistUrl: string,
  signal: AbortSignal,
  targetHeight: number,
  depth: number,
  deadlineAt: number
): Promise<boolean> {
  if (depth > MANIFEST_WARM_MAX_DEPTH || Date.now() >= deadlineAt) return false;
  const text = await fetchWarmManifest(
    playlistUrl,
    signal,
    deadlineAt - Date.now()
  );
  if (!text?.includes("#EXTM3U")) return false;
  const target = selectHlsWarmTarget(text, playlistUrl, targetHeight);
  if (target.kind === "variant" && target.playlistUrl) {
    return warmHlsPathUntil(
      target.playlistUrl,
      signal,
      targetHeight,
      depth + 1,
      deadlineAt
    );
  }
  // Stop at the media playlist. A BYTERANGE playlist can reuse one whole MP4
  // URI for every segment; a blind GET here would download the entire title.
  return target.kind === "media";
}

export function warmHlsPath(
  playlistUrl: string,
  signal: AbortSignal,
  targetHeight: number,
  timeoutMs = MANIFEST_WARM_TIMEOUT_MS
): Promise<boolean> {
  return warmHlsPathUntil(
    playlistUrl,
    signal,
    targetHeight,
    0,
    Date.now() + timeoutMs
  );
}

function pruneManifestWarmCache(now: number): void {
  for (const [url, warmedAt] of recentManifestWarmups) {
    if (now - warmedAt > MANIFEST_WARM_CACHE_TTL_MS) {
      recentManifestWarmups.delete(url);
    }
  }
  while (recentManifestWarmups.size >= MANIFEST_WARM_CACHE_MAX_ENTRIES) {
    const oldest = recentManifestWarmups.keys().next().value as string | undefined;
    if (!oldest) break;
    recentManifestWarmups.delete(oldest);
  }
}

function finishManifestJob(job: ManifestWarmJob): void {
  if (job.finished) return;
  job.finished = true;
  if (activeManifestWarmups.get(job.url) === job) {
    activeManifestWarmups.delete(job.url);
  }
  pumpManifestWarmups();
}

function pumpManifestWarmups(): void {
  while (
    activeManifestWarmups.size < MANIFEST_WARM_MAX_CONCURRENCY &&
    manifestWarmQueue.length > 0
  ) {
    const job = manifestWarmQueue.shift()!;
    activeManifestWarmups.set(job.url, job);
    void warmHlsPath(job.url, job.abort.signal, job.targetHeight)
      .then((warmed) => {
        if (!job.finished && warmed) {
          recentManifestWarmups.set(job.url, Date.now());
        }
      })
      .catch(() => undefined)
      .finally(() => finishManifestJob(job));
  }
}

function preferredManifestWarmHeight(): number {
  try {
    const stored = localStorage.getItem("cinehome:preferred-quality");
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MANIFEST_WARM_HEIGHT;
  } catch {
    return DEFAULT_MANIFEST_WARM_HEIGHT;
  }
}

function abortManifestWarmups(): void {
  const queued = manifestWarmQueue.splice(0);
  for (const job of queued) {
    job.finished = true;
    job.abort.abort();
  }
  for (const job of [...activeManifestWarmups.values()]) {
    job.finished = true;
    job.abort.abort();
    if (activeManifestWarmups.get(job.url) === job) {
      activeManifestWarmups.delete(job.url);
    }
  }
  pumpManifestWarmups();
}

/** Warm master + preferred media playlist; never speculatively fetch media. */
export function prefetchManifestLite(
  streamUrl: string | null | undefined,
  streamType: "hls" | "mp4" | "dash" | undefined
): void {
  if (
    streamType !== "hls" ||
    !streamUrl ||
    typeof window === "undefined" ||
    saveData()
  ) {
    return;
  }
  try {
    const url = new URL(streamUrl, window.location.origin);
    if (url.origin !== window.location.origin) return;
    const key = url.toString();
    const now = Date.now();
    pruneManifestWarmCache(now);
    if (
      activeManifestWarmups.has(key) ||
      manifestWarmQueue.some((job) => job.url === key) ||
      recentManifestWarmups.has(key)
    ) {
      return;
    }
    while (manifestWarmQueue.length >= MANIFEST_WARM_QUEUE_MAX_ENTRIES) {
      const stale = manifestWarmQueue.shift();
      if (!stale) break;
      stale.finished = true;
      stale.abort.abort();
    }
    manifestWarmQueue.push({
      url: key,
      targetHeight: preferredManifestWarmHeight(),
      abort: new AbortController(),
      finished: false,
    });
    pumpManifestWarmups();
  } catch {
    /* ignore */
  }
}

interface PreresolvedPlayback {
  streamUrl?: string;
  sources?: Array<{
    url?: string;
    type?: "hls" | "mp4" | "dash";
  }>;
}

/** Warm only the selected, explicitly-HLS source from a pre-resolve response. */
export function warmPreresolvedPlayback(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const response = data as PreresolvedPlayback;
  const selected =
    response.sources?.find((source) => source.url === response.streamUrl) ??
    response.sources?.[0];
  const url = response.streamUrl ?? selected?.url;
  preconnectStreamOrigin(url);
  prefetchManifestLite(url, selected?.type);
}
