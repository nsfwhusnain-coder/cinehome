/**
 * Videasy / Vidking API — `api.speedracelight.com` + local `enc=2` decrypt.
 *
 * Cypher (`downloader2`) returns a progressive MP4 quality ladder (360–1080)
 * with Vidking-referer hosts. Yoru (`cdn`) is the HLS sibling when it has
 * the title. Kill with PROVIDER_VIDEASY=0.
 */

import type { ProviderStream, TmdbLookup } from "./types";
import { lookupTmdb } from "./tmdb-lookup";
import { decryptVideasyPayload } from "./videasy-crypto";
import { isPoisonStreamUrl } from "../poison-url";
import { rethrowIfProviderOutage, throwIfHttpOutage } from "./provider-outage";

const API_BASE = "https://api.speedracelight.com";
const META_BASE = "https://db.speedracelight.com/3";
const REFERER = "https://www.vidking.net/";
const ORIGIN = "https://www.vidking.net";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 12_000;
const MAX_STREAMS = 6;
const LABEL_BASE = "Quasar";
const PROVIDER_NAME = "Videasy";

export const VIDEASY_TIMEOUT_MS = TIMEOUT_MS;
export const VIDEASY_OUTER_TIMEOUT_MS = 14_000;
export const VIDEASY_MAX_STREAMS = MAX_STREAMS;

export interface VideasyServer {
  name: string;
  endpoint: string;
}

/** English-first servers. Cypher is the proven 1080 MP4 ladder. */
export const VIDEASY_SERVERS: readonly VideasyServer[] = [
  { name: "Cypher", endpoint: "downloader2/sources-with-title" },
  { name: "Yoru", endpoint: "cdn/sources-with-title" },
];

interface VideasyRawSource {
  url?: string;
  quality?: string;
  type?: string;
}

interface VideasyDecrypted {
  sources?: VideasyRawSource[];
}

interface VideasyMeta {
  title: string;
  year: string;
  imdbId: string;
}

const API_HEADERS: Record<string, string> = {
  "User-Agent": DEFAULT_UA,
  Origin: ORIGIN,
  Referer: REFERER,
  Accept: "application/json, text/plain, */*",
};

export function parseVideasyQuality(quality: string): string {
  const match = quality.match(/(\d{3,4})\s*p?/i);
  if (match?.[1]) return `${match[1]}p`;
  return quality.trim() || "auto";
}

export function videasyQualityRank(quality: string): number {
  const n = parseInt(quality, 10);
  if (!Number.isFinite(n)) return -1;
  if (n >= 2160) return 5;
  if (n >= 1080) return 4;
  if (n >= 720) return 3;
  if (n >= 480) return 2;
  if (n >= 360) return 1;
  return 0;
}

export function videasyStreamLabel(quality: string, isBest: boolean): string {
  if (isBest) return LABEL_BASE;
  const q = parseVideasyQuality(quality);
  return q && q !== "auto" ? `${LABEL_BASE} ${q}` : LABEL_BASE;
}

export function detectVideasyStreamType(url: string, type?: string): "hls" | "mp4" | "dash" {
  const hint = (type || "").toLowerCase();
  const lower = url.toLowerCase();
  if (hint === "dash" || lower.includes(".mpd")) return "dash";
  if (hint === "hls" || lower.includes(".m3u8")) return "hls";
  return "mp4";
}

export function buildVideasySourceUrl(
  server: VideasyServer,
  params: {
    title: string;
    mediaType: "movie" | "tv";
    year: string;
    tmdbId: number;
    imdbId: string;
    seed: string;
    season?: number;
    episode?: number;
  }
): string {
  const url = new URL(`${API_BASE}/${server.endpoint}`);
  url.searchParams.set("title", params.title);
  url.searchParams.set("mediaType", params.mediaType);
  url.searchParams.set("year", params.year);
  url.searchParams.set("episodeId", String(params.episode ?? 1));
  url.searchParams.set("seasonId", String(params.season ?? 1));
  url.searchParams.set("tmdbId", String(params.tmdbId));
  url.searchParams.set("imdbId", params.imdbId);
  url.searchParams.set("enc", "2");
  url.searchParams.set("seed", params.seed);
  return url.toString();
}

function qualityHeight(quality: string): number {
  const n = parseInt(parseVideasyQuality(quality), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sortByQuality(sources: VideasyRawSource[]): VideasyRawSource[] {
  return [...sources].sort(
    (a, b) =>
      videasyQualityRank(String(b.quality ?? "")) -
      videasyQualityRank(String(a.quality ?? ""))
  );
}

function mapStreams(raw: VideasyRawSource[]): ProviderStream[] {
  const seen = new Set<string>();
  const rungs: { height: number; url: string; type: "hls" | "mp4" | "dash" }[] = [];
  for (const item of sortByQuality(raw)) {
    const streamUrl = typeof item.url === "string" ? item.url.trim() : "";
    if (!streamUrl || seen.has(streamUrl) || isPoisonStreamUrl(streamUrl)) continue;
    seen.add(streamUrl);
    const quality = parseVideasyQuality(String(item.quality ?? ""));
    const height = qualityHeight(quality);
    rungs.push({
      height: height > 0 ? height : 0,
      url: streamUrl,
      type: detectVideasyStreamType(streamUrl, item.type),
    });
    if (rungs.length >= MAX_STREAMS) break;
  }
  const best = rungs[0];
  if (!best) return [];
  const qualityRungs = rungs
    .filter((rung) => rung.height > 0)
    .map((rung) => ({ height: rung.height, url: rung.url }));
  const ladder = qualityRungs.map((rung) => rung.height);
  const quality = best.height > 0 ? `${best.height}p` : "auto";
  return [
    {
      url: best.url,
      quality,
      label: LABEL_BASE,
      provider: PROVIDER_NAME,
      type: best.type,
      referer: REFERER,
      origin: ORIGIN,
      userAgent: DEFAULT_UA,
      ...(best.height > 0 ? { maxHeight: best.height } : {}),
      ...(ladder.length ? { ladder, qualityRungs } : {}),
    },
  ];
}

async function fetchJson(
  url: string,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    signal,
    headers: { ...API_HEADERS, "Cache-Control": "no-cache, no-store, must-revalidate" },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

export async function fetchVideasySeed(
  tmdbId: number,
  signal?: AbortSignal
): Promise<string | null> {
  const res = await fetchJson(
    `${API_BASE}/seed?mediaId=${encodeURIComponent(String(tmdbId))}`,
    signal ?? AbortSignal.timeout(TIMEOUT_MS)
  );
  throwIfHttpOutage(res.status, "videasy");
  if (!res.ok) return null;
  try {
    const body = JSON.parse(res.text) as { seed?: string };
    return typeof body.seed === "string" && body.seed.length > 0 ? body.seed : null;
  } catch {
    return null;
  }
}

function parseDecrypted(payload: string, seed: string, tmdbId: number): VideasyRawSource[] {
  const parsed = JSON.parse(decryptVideasyPayload(payload, seed, tmdbId)) as VideasyDecrypted;
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

async function fetchServerSources(
  server: VideasyServer,
  seed: string,
  meta: VideasyMeta,
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<VideasyRawSource[]> {
  const url = buildVideasySourceUrl(server, {
    title: meta.title,
    mediaType,
    year: meta.year,
    tmdbId,
    imdbId: meta.imdbId,
    seed,
    season,
    episode,
  });
  const res = await fetchJson(url, AbortSignal.timeout(TIMEOUT_MS));
  throwIfHttpOutage(res.status, "videasy");
  if (!res.ok) return [];
  try {
    return parseDecrypted(res.text, seed, tmdbId);
  } catch {
    return [];
  }
}

function metaFromLookup(lookup: TmdbLookup | null, tmdbId: number): VideasyMeta {
  if (lookup?.title) {
    return {
      title: lookup.title,
      year: lookup.year || "",
      imdbId: lookup.imdbId || "",
    };
  }
  return { title: `tmdb-${tmdbId}`, year: "", imdbId: "" };
}

async function fetchVideasyMeta(
  tmdbId: number,
  mediaType: "movie" | "tv"
): Promise<VideasyMeta> {
  try {
    const res = await fetch(
      `${META_BASE}/${mediaType}/${tmdbId}?append_to_response=external_ids`,
      { headers: API_HEADERS, signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        name?: string;
        release_date?: string;
        first_air_date?: string;
        external_ids?: { imdb_id?: string };
      };
      const title = data.title || data.name || "";
      if (title) {
        const year = (data.release_date || data.first_air_date || "").split("-")[0] || "";
        return { title, year, imdbId: data.external_ids?.imdb_id || "" };
      }
    }
  } catch {
    /* fall through to official TMDB */
  }
  return metaFromLookup(await lookupTmdb(tmdbId, mediaType), tmdbId);
}

function richest(a: VideasyRawSource[], b: VideasyRawSource[]): VideasyRawSource[] {
  const aBest = Math.max(0, ...a.map((s) => qualityHeight(String(s.quality ?? ""))));
  const bBest = Math.max(0, ...b.map((s) => qualityHeight(String(s.quality ?? ""))));
  if (bBest > aBest) return b;
  if (aBest > bBest) return a;
  return a.length >= b.length ? a : b;
}

/**
 * Resolve Videasy/Vidking sources. Empty = title miss, not an outage.
 */
export async function resolveVideasy(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<ProviderStream[]> {
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return [];
  try {
    const seed = await fetchVideasySeed(tmdbId);
    if (!seed) return [];
    const meta = await fetchVideasyMeta(tmdbId, mediaType);
    const settled = await Promise.allSettled(
      VIDEASY_SERVERS.map((server) =>
        fetchServerSources(server, seed, meta, tmdbId, mediaType, season, episode)
      )
    );
    let picked: VideasyRawSource[] = [];
    let sawSuccess = false;
    let outage: unknown = null;
    for (const item of settled) {
      if (item.status === "fulfilled") {
        sawSuccess = true;
        if (item.value.length) picked = richest(picked, item.value);
        continue;
      }
      try {
        rethrowIfProviderOutage(item.reason, "videasy");
      } catch (err) {
        outage = err;
      }
    }
    if (picked.length) return mapStreams(picked);
    if (!sawSuccess && outage) throw outage;
    return [];
  } catch (err) {
    rethrowIfProviderOutage(err, "videasy");
    return [];
  }
}
