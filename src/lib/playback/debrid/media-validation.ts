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
  | "unsupported_container"
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

export type NativeContainerValidationReason =
  | "iso_bmff"
  | "unsupported_signature"
  | "http_error"
  | "network_indeterminate";

export interface NativeContainerValidationResult {
  acceptable: boolean;
  reason: NativeContainerValidationReason;
  container: "mp4" | null;
  status: number | null;
  elapsedMs: number;
}

interface CachedNativeContainerValidation {
  expiresAt: number;
  result: NativeContainerValidationResult;
}

const nativeContainerResultCache = new Map<
  string,
  CachedNativeContainerValidation
>();
const nativeContainerInFlight = new Map<
  string,
  Promise<NativeContainerValidationResult>
>();

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
    // We only need status + headers. Abort the FETCH controller itself so Bun
    // closes the underlying CDN socket immediately. response.body.cancel()
    // alone allowed ignored-Range multi-GB media responses to keep draining
    // asynchronously after this function had returned.
    controller.abort("debrid range headers received");
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

function isIsoBmffHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

async function probeNativeBrowserContainer(
  url: string,
  timeoutMs: number
): Promise<NativeContainerValidationResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-31",
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const status = response.status;
    if (!response.ok) {
      controller.abort("native container probe received an HTTP failure");
      void response.body?.cancel().catch(() => undefined);
      return {
        acceptable: false,
        reason: "http_error",
        container: null,
        status,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    // Never buffer a server that ignored Range: this path exists specifically
    // for unknown multi-gigabyte media objects. A proper 206 response is
    // bounded to the requested 32-byte signature.
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      response.status !== 206 ||
      (Number.isFinite(declaredLength) && declaredLength > 4_096)
    ) {
      controller.abort("native container probe was not range-bounded");
      void response.body?.cancel().catch(() => undefined);
      return {
        acceptable: false,
        reason: "unsupported_signature",
        container: null,
        status,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        acceptable: false,
        reason: "unsupported_signature",
        container: null,
        status,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }
    const bytes = new Uint8Array(32);
    let written = 0;
    let observed = 0;
    while (written < bytes.length) {
      const { done, value } = await reader.read();
      if (done) break;
      observed += value.byteLength;
      if (observed > 4_096) {
        await reader.cancel("native container signature exceeded hard cap");
        return {
          acceptable: false,
          reason: "unsupported_signature",
          container: null,
          status,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      }
      const take = Math.min(value.byteLength, bytes.length - written);
      bytes.set(value.subarray(0, take), written);
      written += take;
    }
    await reader.cancel("native container signature captured");
    const isoBmff = isIsoBmffHeader(bytes);
    return {
      acceptable: isoBmff,
      reason: isoBmff ? "iso_bmff" : "unsupported_signature",
      container: isoBmff ? "mp4" : null,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    // Unlike the size plausibility probe, unknown-container validation must
    // fail closed: surfacing an unverified M2TS/MKV object as native creates
    // a source that the browser cannot play.
    return {
      acceptable: false,
      reason: "network_indeterminate",
      container: null,
      status: null,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Prove that an otherwise unknown native candidate is ISO-BMFF (MP4/MOV)
 * before it can be cached or surfaced to a browser.
 */
export function validateNativeBrowserContainer(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<NativeContainerValidationResult> {
  const cached = nativeContainerResultCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result);
  }
  if (cached) nativeContainerResultCache.delete(url);

  const existing = nativeContainerInFlight.get(url);
  if (existing) return existing;

  const probe = probeNativeBrowserContainer(url, timeoutMs)
    .then((result) => {
      nativeContainerResultCache.set(url, {
        result,
        expiresAt:
          Date.now() + (result.acceptable ? VALID_TTL_MS : INVALID_TTL_MS),
      });
      return result;
    })
    .finally(() => {
      nativeContainerInFlight.delete(url);
    });
  nativeContainerInFlight.set(url, probe);
  return probe;
}

/** Test-only reset for deterministic cache/single-flight coverage. */
export function clearMediaValidationCache(): void {
  resultCache.clear();
  inFlight.clear();
  nativeContainerResultCache.clear();
  nativeContainerInFlight.clear();
}
