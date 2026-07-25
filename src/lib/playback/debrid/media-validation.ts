import type { MediaType } from "../types";

/**
 * Conservative plausibility floors, not quality thresholds. They reject
 * samples, trailers, HTML error bodies, and short clips while remaining far
 * below the size of a normal feature or episode.
 */
export const MIN_MOVIE_BYTES = 50 * 1024 * 1024;
export const MIN_EPISODE_BYTES = 15 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 2_000;
const VALID_TTL_MS = 10 * 60 * 1000;
const INVALID_TTL_MS = 60 * 1000;
const INDETERMINATE_TTL_MS = 30 * 1000;

export type MediaValidationReason =
  | "plausible_size"
  | "size_unknown"
  | "http_error"
  | "too_small"
  | "network_indeterminate";

export interface MediaValidationResult {
  /**
   * False is reserved for conclusive evidence that this cannot be the full
   * requested item. An origin that does not expose a size remains usable.
   */
  acceptable: boolean;
  reason: MediaValidationReason;
  totalBytes: number | null;
  status: number | null;
  elapsedMs: number;
}

interface CachedValidation {
  expiresAt: number;
  result: MediaValidationResult;
}

const resultCache = new Map<string, CachedValidation>();
const inFlight = new Map<string, Promise<MediaValidationResult>>();

function totalBytesFromHeaders(response: Response): number | null {
  const contentRange = response.headers.get("content-range");
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)\s*$/);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }

  // A 206 Content-Length is the returned range length, not the whole object.
  // A 200 means the origin ignored Range, so its Content-Length is the total.
  if (response.status === 200) {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsed = Number(contentLength);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}

function ttlFor(result: MediaValidationResult): number {
  if (!result.acceptable) return INVALID_TTL_MS;
  return result.reason === "plausible_size" ? VALID_TTL_MS : INDETERMINATE_TTL_MS;
}

async function probeMediaLink(
  url: string,
  mediaType: MediaType,
  timeoutMs: number
): Promise<MediaValidationResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const status = response.status;
    const totalBytes = totalBytesFromHeaders(response);
    void response.body?.cancel().catch(() => undefined);
    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      return { acceptable: false, reason: "http_error", totalBytes, status, elapsedMs };
    }

    const minimumBytes = mediaType === "movie" ? MIN_MOVIE_BYTES : MIN_EPISODE_BYTES;
    if (totalBytes !== null && totalBytes < minimumBytes) {
      return { acceptable: false, reason: "too_small", totalBytes, status, elapsedMs };
    }

    return {
      acceptable: true,
      reason: totalBytes === null ? "size_unknown" : "plausible_size",
      totalBytes,
      status,
      elapsedMs,
    };
  } catch {
    // Range probes can be unsupported even when browser playback works.
    // Preserve availability unless the response conclusively failed.
    return {
      acceptable: true,
      reason: "network_indeterminate",
      totalBytes: null,
      status: null,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bounded validation shared by fresh resolves and every RD cache-read path.
 * Concurrent callers for the same direct link share one Range request.
 */
export function validateDebridMediaLink(
  url: string,
  mediaType: MediaType,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<MediaValidationResult> {
  const cached = resultCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  if (cached) resultCache.delete(url);

  const existing = inFlight.get(url);
  if (existing) return existing;

  const probe = probeMediaLink(url, mediaType, timeoutMs)
    .then((result) => {
      resultCache.set(url, { result, expiresAt: Date.now() + ttlFor(result) });
      return result;
    })
    .finally(() => {
      inFlight.delete(url);
    });
  inFlight.set(url, probe);
  return probe;
}

/** Test-only reset for deterministic cache/single-flight coverage. */
export function clearMediaValidationCache(): void {
  resultCache.clear();
  inFlight.clear();
}
