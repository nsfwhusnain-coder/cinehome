import type { MediaType, PlaybackResponse, PlaybackSource } from "./types";
import { decideImmediateSource } from "./decide-playback";

/**
 * Shared debrid-merge helpers — extracted from the playback route so that any
 * route which needs to look up a source by id (e.g. /api/transcode) can
 * reproduce the SAME full roster (embed + debrid) the playback route returns.
 *
 * The debrid tier (Real-Debrid + Torrentio) is NOT part of provider.resolve()
 * — it's a separate parallel call merged in here. Without this, debrid source
 * ids are invisible to routes that only call provider.resolve().
 */

/**
 * Dynamically imported so the Prisma-backed debrid module only loads on the
 * full resolve path. Wrapped in try/catch so an import or resolve failure
 * never breaks the base (embed) response.
 */
export async function resolveDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveDebridSources } = await import("@/lib/playback/debrid");
    return await resolveDebridSources(req);
  } catch {
    return [];
  }
}

/**
 * Fast/prefetch-path counterpart — cache-only check for the single best
 * native RD source, hard-bounded to its own short defensive deadline
 * internally (see `resolveFastDebridSources` in src/lib/playback/debrid/index.ts
 * — it never performs a live network resolve on this path). Wrapped in
 * try/catch so an import or resolve failure never breaks the base fast response.
 */
export async function resolveFastDebridSourcesSafely(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): Promise<PlaybackSource[]> {
  try {
    const { resolveFastDebridSources } = await import("@/lib/playback/debrid");
    return await resolveFastDebridSources(req);
  } catch {
    return [];
  }
}

/**
 * Merge debrid sources into an already-resolved response — the existing
 * scoreSource/pickDefaultSource ranking (source-quality.ts) re-ranks the
 * combined roster and may promote a debrid source to default. If the base
 * roster came back empty (error/not_configured) but debrid found something,
 * promote the response to "available" so the premium tier can stand alone.
 */
export function mergeDebridSources(
  result: PlaybackResponse,
  debridSources: PlaybackSource[],
  qualityHint?: "auto" | number
): void {
  if (!debridSources.length) return;
  const merged = [...(result.sources ?? []), ...debridSources];
  result.sources = merged;
  const best =
    decideImmediateSource(merged, { preferredHeight: qualityHint ?? "auto" }) ??
    merged[0];
  if (!best) return;
  result.streamUrl = best.url;
  if (result.status === "error" || result.status === "not_configured") {
    result.status = "available";
    result.message = undefined;
    result.action = undefined;
  }
}
