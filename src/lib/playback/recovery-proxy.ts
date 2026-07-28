import {
  createHlsSession,
  encodeUpstream,
} from "@/lib/hls-session";
import type { PlaybackSource } from "./types";

const RECOVERY_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function upstreamOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "https://real-debrid.com";
  }
}

/**
 * Route every debrid object through CineHome's authenticated streaming proxy.
 *
 * Real-Debrid CDN nodes do not have one stable browser-CORS policy: a link can
 * pass the server-side Range/media validation and still be rejected by the
 * browser because that particular node omits Access-Control-Allow-Origin.
 * Keeping the normal URL same-origin makes the already-validated object
 * reliably playable while preserving streaming Range responses.
 *
 * The HLS session id is deterministic for user + upstream URL, so an ordinary
 * resolve gets a stable, generation-independent browser URL. A recovery resolve
 * appends its nonce solely as a browser cache-buster; it does not alter the
 * upstream URL or create a second proxy session.
 */
export function proxyDebridSources(
  userId: string,
  sources: PlaybackSource[],
  refreshNonce?: number
): PlaybackSource[] {
  return sources.map((source) => {
    const origin = upstreamOrigin(source.url);
    const session = createHlsSession(userId, source.url, {
      referer: `${origin}/`,
      origin,
      userAgent: RECOVERY_PROXY_USER_AGENT,
      cookies: "",
    });
    const stableProxyUrl =
      `/api/hls/${session.id}?u=${encodeUpstream(source.url)}`;
    const proxyUrl =
      refreshNonce == null
        ? stableProxyUrl
        : `${stableProxyUrl}&recovery=${refreshNonce}`;
    return { ...source, url: proxyUrl };
  });
}

/** Backwards-compatible name for the explicit recovery call site/tests. */
export function proxyRecoveryDebridSources(
  userId: string,
  sources: PlaybackSource[],
  refreshNonce: number
): PlaybackSource[] {
  return proxyDebridSources(userId, sources, refreshNonce);
}
