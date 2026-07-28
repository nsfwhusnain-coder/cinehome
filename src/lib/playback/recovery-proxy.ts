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
 * A roster refresh must produce a browser-distinct media URL even when
 * Real-Debrid legitimately returns the same still-valid signed CDN link.
 *
 * Browsers may retain a failed media response for a direct URL. Reattaching
 * that exact URL can therefore fail locally without issuing a new request.
 * Route recovery-only debrid traffic through the authenticated streaming
 * proxy and add the roster generation to its ignored query parameters. The
 * upstream URL stays unchanged, Range requests remain streaming, and normal
 * healthy playback remains direct (zero extra home-server hop).
 */
export function proxyRecoveryDebridSources(
  userId: string,
  sources: PlaybackSource[],
  refreshNonce: number
): PlaybackSource[] {
  return sources.map((source) => {
    const origin = upstreamOrigin(source.url);
    const session = createHlsSession(userId, source.url, {
      referer: `${origin}/`,
      origin,
      userAgent: RECOVERY_PROXY_USER_AGENT,
      cookies: "",
    });
    const proxyUrl =
      `/api/hls/${session.id}?u=${encodeUpstream(source.url)}` +
      `&recovery=${refreshNonce}`;
    return { ...source, url: proxyUrl };
  });
}
