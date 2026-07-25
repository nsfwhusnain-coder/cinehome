/**
 * Pure HLS playlist URL-rewriting for the transcode-serving route
 * (src/app/api/transcode/route.ts). No network, no fs — a deterministic
 * string transform so it can be unit-tested without spinning up Next.js or
 * the transcoder mini-service.
 *
 * Rewrites every non-comment line — a segment (.ts) reference OR a variant
 * sub-playlist (.m3u8) reference; the master-vs-media distinction doesn't
 * matter, both are "take the basename, point it at the seg proxy route" — to
 * `/api/transcode/seg?key=<key>&f=<basename>`, so the browser never talks to
 * the transcoder's internal :3040 port directly.
 *
 * Applied TWICE per playback session for a multi-rung ladder:
 *   1. The route's top-level GET rewrites the fetched master.m3u8, turning
 *      its `v0.m3u8`/`v1.m3u8`/... references into seg-proxy URLs.
 *   2. The `/api/transcode/seg` passthrough rewrites AGAIN whenever the
 *      proxied file is itself a playlist (`f` ends in `.m3u8`) — this turns
 *      each variant playlist's OWN segment references into seg-proxy URLs
 *      too. Without this second pass, the browser can fetch the (rewritten)
 *      master fine, but every segment inside a variant playlist would still
 *      point at a bare filename the browser can't resolve.
 * For the single-rung flat-master shape (master.m3u8 IS the media playlist,
 * no variant sub-playlists) this collapses to a single rewrite pass — the
 * function itself doesn't need to know which shape it's rewriting.
 */

const SEG_ROUTE_PREFIX = "/api/transcode/seg";

export function rewritePlaylist(playlist: string, key: string): string {
  const base = `${SEG_ROUTE_PREFIX}?key=${key}&f=`;
  return playlist
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      // Defensively reduce to a basename before building the URL — the
      // transcoder only ever emits flat filenames (no subdirectories), but
      // upstream playlist content should never be trusted as a safe path
      // component without stripping directory separators first.
      const file = trimmed.split("/").pop() || trimmed;
      return `${base}${encodeURIComponent(file)}`;
    })
    .join("\n");
}

/**
 * True when a playlist's non-comment lines reference sub-playlists (a
 * multi-rung ladder's master) rather than segments (a media playlist, or a
 * flat single-rung master). `rewritePlaylist` doesn't need this distinction
 * (its transform is identical either way) — this exists so callers that DO
 * care about the shape (e.g. deciding whether to wait for a variant
 * playlist) have a single source of truth for "what kind of playlist is
 * this."
 */
export function isMasterPlaylist(playlist: string): boolean {
  return playlist
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .some((l) => l.endsWith(".m3u8"));
}
