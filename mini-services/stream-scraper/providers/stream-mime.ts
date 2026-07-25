/**
 * Shared stream detection helpers — extension + MIME sniffing used by the
 * Playwright interception layer (index.ts tryScrapeUrl) to decide whether an
 * intercepted network response is a real media asset worth capturing.
 *
 * Kept as pure functions (no network, no Playwright types) so they are
 * trivially unit-testable and reusable by any current/future embed provider
 * without duplicating the same regex/substring checks per-provider.
 */

/** Minimum body size (via Content-Length) to treat an extension-less MIME
 * hit as a real video asset rather than a tiny JSON/error/tracking response. */
export const MIME_CAPTURE_MIN_BYTES = 50_000;

const STREAM_EXTENSIONS = [".m3u8", ".mpd", ".mp4", ".m4s"];

/** True when the URL itself carries a recognized stream/segment extension. */
export function hasStreamExtension(url: string): boolean {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  return STREAM_EXTENSIONS.some((ext) => lower.includes(ext));
}

/**
 * True when a Content-Type header indicates real media — HLS/DASH manifests
 * or MPEG-TS/MP4 segment bodies — even when the URL has no matching
 * extension (some CDNs serve segments from opaque/obfuscated paths).
 */
export function isLikelyVideoMime(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes("video/mp2t") ||
    ct.includes("video/mp4") ||
    ct.includes("application/vnd.apple.mpegurl") ||
    ct.includes("application/x-mpegurl") ||
    ct.includes("application/dash+xml")
  );
}

/** Best-effort capture label from a Content-Type string. */
export function labelFromMime(contentType: string): "HLS" | "DASH" | "MP4" {
  const ct = contentType.toLowerCase();
  if (ct.includes("mpegurl")) return "HLS";
  if (ct.includes("dash+xml")) return "DASH";
  return "MP4";
}

/**
 * Whether a MIME-sniffed hit (no matching URL extension) is worth capturing:
 * either the size is unknown (chunked transfer — common for real segments)
 * or it clears the "large body" floor. Filters out small JSON/pixel/ad
 * responses that a CDN mislabels with a video content-type.
 */
export function isCaptureWorthySize(contentLengthBytes: number | null): boolean {
  if (contentLengthBytes == null) return true;
  return contentLengthBytes >= MIME_CAPTURE_MIN_BYTES;
}
