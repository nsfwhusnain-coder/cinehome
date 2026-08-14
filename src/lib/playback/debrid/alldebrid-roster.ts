/**
 * AllDebrid roster — Torrentio `alldebrid=` instant links only.
 * Two rows per title (4K + 1080), same shape as TorBox, so adding a key
 * never changes the Real-Debrid engine.
 */
import type { MediaType, PlaybackSource } from "../types";
import { getAllDebridToken, isAllDebridConfigured } from "./alldebrid";
import {
  fetchTorrentioCandidates,
  resolveImdbId,
  type DebridCandidate,
} from "./torrentio";
import { resolveTokenFreeRedirect, sanitizeStreamUrl } from "./token-safety";
import { validateDebridMediaLink } from "./media-validation";
import {
  getFreshCachedStream,
  upsertCachedStream,
  type CachedStreamRecord,
  type DebridQuality,
} from "./cached-stream";

const AD_VALIDATE_MS = 4_000;

function pickBest(candidates: DebridCandidate[], height: 1080 | 2160): DebridCandidate | null {
  const native = candidates.find(
    (c) => c.compat === "native" && c.resolutionHeight === height && c.url
  );
  if (native) return native;
  return (
    candidates.find((c) => c.resolutionHeight === height && c.url) ?? null
  );
}

function toSource(
  quality: DebridQuality,
  imdbId: string,
  mediaType: MediaType,
  season: number,
  episode: number,
  record: Pick<CachedStreamRecord, "url" | "compat" | "title">,
  codec?: DebridCandidate["codec"]
): PlaybackSource {
  const height = quality === "2160p" ? 2160 : 1080;
  const safari = codec === "hevc" || record.compat === "safari" ? " · Safari" : "";
  return {
    id: `alldebrid-${imdbId}-${mediaType}-${season}-${episode}-${quality}`,
    url: record.url,
    provider: "AllDebrid",
    quality,
    label: `AllDebrid · ${quality === "2160p" ? "4K" : "1080p"}${safari}`,
    type: "mp4",
    maxHeight: height,
    origin: "debrid",
    compat: record.compat,
    ...(codec && codec !== "unknown" ? { codec } : {}),
  };
}

async function resolveOne(
  candidate: DebridCandidate,
  token: string
): Promise<CachedStreamRecord | null> {
  if (!candidate.url) return null;
  const direct = await resolveTokenFreeRedirect(candidate.url, token, 8_000);
  const safe = sanitizeStreamUrl(direct, token);
  if (!safe) return null;
  return {
    title: candidate.title,
    source: candidate.infoHash || candidate.title,
    url: safe,
    compat: candidate.compat,
    codec: candidate.codec,
    container: candidate.container,
  };
}

export async function resolveAllDebridSources(req: {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): Promise<PlaybackSource[]> {
  if (!isAllDebridConfigured()) return [];
  const token = getAllDebridToken();
  if (!token) return [];

  const imdbId = await resolveImdbId(req.tmdbId, req.mediaType);
  if (!imdbId) return [];

  const season = req.season ?? 0;
  const episode = req.episode ?? 0;
  const keyBase = { imdbId, mediaType: req.mediaType, season, episode };

  const out: PlaybackSource[] = [];
  const qualities: DebridQuality[] = ["2160p", "1080p"];
  let candidates: DebridCandidate[] | null = null;

  for (const quality of qualities) {
    const hit = await getFreshCachedStream({
      ...keyBase,
      quality,
      provider: "alldebrid",
    });
    const safe = hit ? sanitizeStreamUrl(hit.url, token) : null;
    if (hit && safe) {
      const validation = await validateDebridMediaLink(safe, req.mediaType, AD_VALIDATE_MS);
      if (validation?.acceptable) {
        out.push(
          toSource(quality, imdbId, req.mediaType, season, episode, {
            ...hit,
            url: safe,
          }, hit.codec)
        );
        continue;
      }
    }

    if (!candidates) {
      candidates = await fetchTorrentioCandidates({
        imdbId,
        mediaType: req.mediaType,
        season: req.season,
        episode: req.episode,
        rdToken: token,
        service: "alldebrid",
      });
    }
    const height = quality === "2160p" ? 2160 : 1080;
    const pick = pickBest(candidates, height);
    if (!pick) continue;
    const record = await resolveOne(pick, token);
    if (!record) continue;
    const validation = await validateDebridMediaLink(record.url, req.mediaType, AD_VALIDATE_MS);
    if (!validation?.acceptable) continue;
    await upsertCachedStream({ ...keyBase, quality, provider: "alldebrid" }, record);
    out.push(
      toSource(quality, imdbId, req.mediaType, season, episode, record, pick.codec)
    );
  }

  return out;
}
