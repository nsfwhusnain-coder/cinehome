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
const UHD_RANK = 5;

export const VIDEASY_TIMEOUT_MS = TIMEOUT_MS;
/**
 * Seed + meta + both servers can legitimately take longer than one 12s
 * fetch. The old 14s outer cap aborted Yoru mid-flight and dropped the
 * only native 4K ladder — same title, same browser, sometimes 4K,
 * sometimes not.
 */
export const VIDEASY_OUTER_TIMEOUT_MS = 28_000;
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
  const raw = (quality || "").trim();
  const lower = raw.toLowerCase();
  if (/\b(8k|4320)\b/.test(lower)) return "4320p";
  if (/\b(4k|uhd|2160)\b/.test(lower)) return "2160p";
  if (/\b(2k|1440)\b/.test(lower)) return "1440p";
  const match = raw.match(/(\d{3,4})\s*p?/i);
  if (match?.[1]) return `${match[1]}p`;
  return raw || "auto";
}

export function videasyQualityRank(quality: string): number {
  const n = parseInt(parseVideasyQuality(quality), 10);
  if (!Number.isFinite(n)) return -1;
  if (n >= 2160) return UHD_RANK;
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

type VideasyRung = { height: number; url: string; type: "hls" | "mp4" | "dash" };

function streamFromRungs(rungs: VideasyRung[], label: string): ProviderStream | null {
  const best = rungs[0];
  if (!best) return null;
  const qualityRungs = rungs
    .filter((rung) => rung.height > 0)
    .map((rung) => ({ height: rung.height, url: rung.url }));
  const ladder = qualityRungs.map((rung) => rung.height);
  const quality = best.height > 0 ? `${best.height}p` : "auto";
  return {
    url: best.url,
    quality,
    label,
    provider: PROVIDER_NAME,
    type: best.type,
    referer: REFERER,
    origin: ORIGIN,
    userAgent: DEFAULT_UA,
    audioLanguage: "en",
    ...(best.height > 0 ? { maxHeight: best.height } : {}),
    ...(ladder.length ? { ladder, qualityRungs } : {}),
  };
}

function mapStreams(raw: VideasyRawSource[]): ProviderStream[] {
  const seen = new Set<string>();
  const rungs: VideasyRung[] = [];
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
  const uhd = rungs.filter((rung) => rung.height >= 2160);
  const hd = rungs.filter((rung) => rung.height > 0 && rung.height < 2160);
  const unknown = rungs.filter((rung) => rung.height <= 0);
  const fourK = streamFromRungs(uhd, LABEL_BASE);
  const hdStream = streamFromRungs(
    hd.length ? hd : fourK ? [] : unknown,
    fourK ? `${LABEL_BASE} 2` : LABEL_BASE
  );
  return [fourK, hdStream].filter((row): row is ProviderStream => row != null);
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

function mergeServerSources(
  current: VideasyRawSource[],
  next: VideasyRawSource[]
): VideasyRawSource[] {
  if (!next.length) return current;
  if (!current.length) return next;
  return [...current, ...next];
}

/**
 * Sibling servers can 200-empty while another 429s. That is an outage, not
 * a title miss — returning [] would write an 18h EMPTY_SKIP.
 */
export function throwIfVideasyEmptyOutage(
  pickedCount: number,
  outage: unknown
): void {
  if (pickedCount === 0 && outage != null) throw outage;
}

function sourcesHaveUhd(sources: VideasyRawSource[]): boolean {
  return sources.some(
    (item) => videasyQualityRank(String(item.quality ?? "")) >= UHD_RANK
  );
}

async function collectServerSources(
  servers: readonly VideasyServer[],
  seed: string,
  meta: VideasyMeta,
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<{ picked: VideasyRawSource[]; sawSuccess: boolean; outage: unknown }> {
  const settled = await Promise.allSettled(
    servers.map((server) =>
      fetchServerSources(server, seed, meta, tmdbId, mediaType, season, episode)
    )
  );
  let picked: VideasyRawSource[] = [];
  let sawSuccess = false;
  let outage: unknown = null;
  for (const item of settled) {
    if (item.status === "fulfilled") {
      sawSuccess = true;
      if (item.value.length) picked = mergeServerSources(picked, item.value);
      continue;
    }
    try {
      rethrowIfProviderOutage(item.reason, "videasy");
    } catch (err) {
      outage = err;
    }
  }
  return { picked, sawSuccess, outage };
}

/**
 * Resolve Videasy/Vidking sources. Empty with no outage = title miss.
 * Cypher is the 1080 MP4 ladder. Yoru is the native 4K HLS. If the first
 * pass only sees Cypher, retry Yoru once before giving up on 4K.
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
    let { picked, outage } = await collectServerSources(
      VIDEASY_SERVERS,
      seed,
      meta,
      tmdbId,
      mediaType,
      season,
      episode
    );
    if (!sourcesHaveUhd(picked)) {
      const yoru = VIDEASY_SERVERS.filter((server) =>
        server.endpoint.startsWith("cdn/")
      );
      if (yoru.length) {
        const retry = await collectServerSources(
          yoru,
          seed,
          meta,
          tmdbId,
          mediaType,
          season,
          episode
        );
        if (retry.outage) outage = retry.outage;
        picked = mergeServerSources(picked, retry.picked);
      }
    }
    if (picked.length) return mapStreams(picked);
    throwIfVideasyEmptyOutage(picked.length, outage);
    return [];
  } catch (err) {
    rethrowIfProviderOutage(err, "videasy");
    return [];
  }
}
