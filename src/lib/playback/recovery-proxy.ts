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
 * Route a debrid object through CineHome's authenticated streaming proxy.
 *
 * This is the recovery transport, not the primary transport. Native MP4
 * debrid links start materially faster when attached directly without a
 * crossOrigin attribute, while the proxy remains useful when a CDN/browser
 * combination rejects that direct path. The session id is deterministic for
 * user + upstream URL; a recovery nonce is only a browser cache-buster.
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

/**
 * Browser transport policy for debrid:
 * - ordinary resolve: keep the validated, token-free CDN URL for fast native
 *   range playback;
 * - explicit recovery: switch the refreshed object to the authenticated
 *   same-origin proxy, giving a failed direct transport a genuinely different
 *   path instead of retrying the same conditions.
 */
export function prepareDebridSourcesForBrowser(
  userId: string,
  sources: PlaybackSource[],
  refreshNonce?: number
): PlaybackSource[] {
  if (refreshNonce == null) return sources.map((source) => ({ ...source }));
  return proxyDebridSources(userId, sources, refreshNonce);
}

/** Backwards-compatible name for the explicit recovery call site/tests. */
export function proxyRecoveryDebridSources(
  userId: string,
  sources: PlaybackSource[],
  refreshNonce: number
): PlaybackSource[] {
  return proxyDebridSources(userId, sources, refreshNonce);
}
