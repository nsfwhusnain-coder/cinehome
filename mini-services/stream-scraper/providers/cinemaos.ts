/**
 * CinemaOS pure-HTTP provider — /api/cinemaosv2 MovieBox MP4 ladder.
 * Progressive MP4 via worker proxies. Prefer English; skip Hydra/iframe catalog.
 *
 * Gate token + hash secret are public in the cinemaos.tech Next.js bundle and
 * may rotate; kill with PROVIDER_CINEMAOS=0 if the API breaks.
 */

import type { ProviderStream } from "./types";
import { isPoisonStreamUrl } from "../poison-url";

const BASE = "https://cinemaos.tech";
/** NEXT_PUBLIC_API_HASH_SECRET from cinemaos.tech client bundle (may rotate). */
const HASH_SECRET =
  "a53ce07ac6250a232ec81d256d3a9db8e399f883cfc5370995388b683882f572";
/** Gate token `_gt` from the same bundle (may rotate). */
const GATE_TOKEN = "6775dc8e702c08643385273df088c14952c590ddda02d14f";
const TIMEOUT_MS = 12_000;
const MAX_STREAMS = 6;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REFERER_ORIGIN = "https://cinemaos.tech";

/** Outer withTimeout budget slightly above AbortSignal.timeout. */
export const CINEMAOS_OUTER_TIMEOUT_MS = 14_000;
export const CINEMAOS_TIMEOUT_MS = TIMEOUT_MS;
export const CINEMAOS_MAX_STREAMS = MAX_STREAMS;
/** Keep 4K + 1080 (or the two richest rungs) per language, not every 360p file. */
export const CINEMAOS_MAX_PER_LANGUAGE = 2;

export function cinemaosLanguageKey(stream: RankableCinemaosStream): string {
  const text = `${stream.name} ${stream.title}`;
  if (isCinemaosEnglish(text)) return "EN";
  return extractLangCode(text) ?? "XX";
}

/** One language = one ladder. Other sites expose rungs on a single source. */
export function keepCinemaosLanguageLadders<T extends RankableCinemaosStream>(
  streams: T[],
  perLanguage = CINEMAOS_MAX_PER_LANGUAGE
): T[] {
  const sorted = sortCinemaosStreams(streams);
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const stream of sorted) {
    const key = cinemaosLanguageKey(stream);
    const taken = counts.get(key) ?? 0;
    if (taken >= perLanguage) continue;
    counts.set(key, taken + 1);
    out.push(stream);
  }
  return out;
}

interface CinemaosRawStream {
  name?: string;
  title?: string;
  quality?: string;
  url?: string;
}

interface CinemaosResponse {
  streams?: CinemaosRawStream[];
}

const LANG_CODES: Record<string, string> = {
  english: "EN",
  hindi: "HI",
  arabic: "AR",
  french: "FR",
  spanish: "ES",
  german: "DE",
  portuguese: "PT",
  japanese: "JA",
  korean: "KO",
  chinese: "ZH",
  mandarin: "ZH",
  tamil: "TA",
  telugu: "TE",
  malayalam: "ML",
  bengali: "BN",
  italian: "IT",
  russian: "RU",
  turkish: "TR",
  indonesian: "ID",
  thai: "TH",
  vietnamese: "VI",
  dutch: "NL",
  polish: "PL",
  urdu: "UR",
  punjabi: "PA",
  marathi: "MR",
  kannada: "KN",
};

/**
 * Minute-bucket hash used by cinemaos.tech client for /api/cinemaosv2.
 * Int32 djb2-ish fold + hex abs + base36 minute bucket.
 */
export function cinemaosHash(tmdbId: number, minuteBucket?: number): string {
  const bucket =
    minuteBucket != null && Number.isFinite(minuteBucket)
      ? Math.floor(minuteBucket)
      : Math.floor(Date.now() / 60_000);
  const payload = `${tmdbId}:${bucket}:${HASH_SECRET}`;
  let x = 0;
  for (let i = 0; i < payload.length; i++) {
    x = ((x << 5) - x + payload.charCodeAt(i)) | 0;
  }
  const a = Math.abs(x).toString(16).padStart(8, "0");
  return `${a}-${bucket.toString(36)}`;
}

export function isCinemaosEnglish(text: string): boolean {
  return /\benglish\b/i.test(text) || /\(en\)/i.test(text);
}

/** Parse height from quality field or free-text name (e.g. "1080p", "720"). */
export function parseCinemaosQuality(quality: string, name = ""): string {
  const fromField = quality.match(/(\d{3,4})\s*p?/i)?.[1];
  if (fromField) return `${fromField}p`;
  const fromName = name.match(/(\d{3,4})\s*p/i)?.[1];
  if (fromName) return `${fromName}p`;
  return quality.trim() || "auto";
}

export function cinemaosQualityRank(quality: string): number {
  const n = parseInt(quality, 10);
  if (!Number.isFinite(n)) return -1;
  if (n >= 2160) return 5;
  if (n >= 1080) return 4;
  if (n >= 720) return 3;
  if (n >= 480) return 2;
  if (n >= 360) return 1;
  return 0;
}

/**
 * CinemaOS sometimes returns a worker-wrapped DASH fallback alongside direct
 * progressive files. In real playback the MPD succeeds but its bcdn media
 * request immediately rate-limits (HTTP 429); two separate titles reproduced
 * this while sibling hcdn/macdn MP4 files decoded normally.
 */
export function isCinemaosRateLimitedWorkerUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "cinemaos.workers.dev" || host.endsWith(".cinemaos.workers.dev");
  } catch {
    return false;
  }
}

export function isCinemaosRejectedStreamUrl(raw: string): boolean {
  return isCinemaosRateLimitedWorkerUrl(raw) || isPoisonStreamUrl(raw);
}

function extractLangCode(text: string): string | null {
  const paren = text.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const key = paren[1].trim().toLowerCase();
    if (LANG_CODES[key]) return LANG_CODES[key];
    // Short codes inside parens: (EN), (HI)
    if (/^[a-z]{2,3}$/i.test(key)) return key.toUpperCase();
  }
  for (const [name, code] of Object.entries(LANG_CODES)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) return code;
  }
  return null;
}

export interface RankableCinemaosStream {
  name: string;
  title: string;
  quality: string;
  url: string;
}

/**
 * Prefer English (case-insensitive name/title), then quality 2160>1080>720>480>360.
 * Pure helper for unit tests + resolveCinemaos.
 */
export function sortCinemaosStreams<T extends RankableCinemaosStream>(streams: T[]): T[] {
  return [...streams].sort((a, b) => {
    const aText = `${a.name} ${a.title}`;
    const bText = `${b.name} ${b.title}`;
    const aEn = isCinemaosEnglish(aText) ? 1 : 0;
    const bEn = isCinemaosEnglish(bText) ? 1 : 0;
    if (aEn !== bEn) return bEn - aEn;
    return cinemaosQualityRank(b.quality) - cinemaosQualityRank(a.quality);
  });
}

function heightDigits(quality: string): string {
  const n = parseInt(quality, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : quality.replace(/p$/i, "") || "auto";
}

/**
 * Best English → "Cinema"; other English → "Cinema 1080p";
 * non-English → "Cinema HI 1080".
 */
export function cinemaosStreamLabel(
  stream: RankableCinemaosStream,
  options: { isBestEnglish: boolean }
): string {
  const text = `${stream.name} ${stream.title}`;
  const english = isCinemaosEnglish(text);
  const q = stream.quality;
  if (english) {
    if (options.isBestEnglish) return "Cinema";
    return q && q !== "auto" ? `Cinema ${q}` : "Cinema EN";
  }
  const code = extractLangCode(text) ?? "XX";
  const h = heightDigits(q);
  return `Cinema ${code} ${h}`;
}

function watchReferer(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): string {
  if (mediaType === "tv") {
    const s = season != null && Number.isFinite(season) ? season : 1;
    const e = episode != null && Number.isFinite(episode) ? episode : 1;
    return `${BASE}/tv/watch/${tmdbId}?season=${s}&episode=${e}`;
  }
  return `${BASE}/movie/watch/${tmdbId}`;
}

function buildApiUrl(
  tmdbId: number,
  mediaType: "movie" | "tv",
  h: string,
  season?: number,
  episode?: number,
  title?: string
): string {
  const params = new URLSearchParams({
    tmdbId: String(tmdbId),
    type: mediaType,
    h,
    _gt: GATE_TOKEN,
  });
  if (title?.trim()) params.set("title", title.trim());
  if (
    mediaType === "tv" &&
    season != null &&
    Number.isFinite(season) &&
    episode != null &&
    Number.isFinite(episode)
  ) {
    params.set("season", String(season));
    params.set("episode", String(episode));
  }
  return `${BASE}/api/cinemaosv2?${params.toString()}`;
}

async function fetchCinemaosv2(
  url: string,
  referer: string,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; body: CinemaosResponse | null }> {
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": DEFAULT_UA,
      Referer: referer,
      Origin: REFERER_ORIGIN,
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, body: null };
  }
  try {
    const body = (await res.json()) as CinemaosResponse;
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false, status: res.status, body: null };
  }
}

/**
 * Resolve progressive MP4 streams from CinemaOS /api/cinemaosv2.
 * Prefer English; cap at MAX_STREAMS. On 403, retry once with a fresh minute hash.
 */
export async function resolveCinemaos(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options?: { title?: string }
): Promise<ProviderStream[]> {
  const referer = watchReferer(tmdbId, mediaType, season, episode);
  const title = options?.title;

  const attempt = async (minuteBucket: number): Promise<{
    status: number;
    streams: RankableCinemaosStream[];
  }> => {
    const h = cinemaosHash(tmdbId, minuteBucket);
    const url = buildApiUrl(tmdbId, mediaType, h, season, episode, title);
    const { ok, status, body } = await fetchCinemaosv2(
      url,
      referer,
      AbortSignal.timeout(TIMEOUT_MS)
    );
    if (!ok || !body?.streams?.length) {
      return { status, streams: [] };
    }
    const mapped: RankableCinemaosStream[] = [];
    const seen = new Set<string>();
    for (const raw of body.streams) {
      const streamUrl = typeof raw.url === "string" ? raw.url.trim() : "";
      if (
        !streamUrl ||
        seen.has(streamUrl) ||
        isCinemaosRejectedStreamUrl(streamUrl)
      ) {
        continue;
      }
      seen.add(streamUrl);
      const name = String(raw.name ?? "");
      const stitle = String(raw.title ?? "");
      const quality = parseCinemaosQuality(String(raw.quality ?? ""), name);
      mapped.push({ name, title: stitle, quality, url: streamUrl });
    }
    return { status, streams: mapped };
  };

  try {
    const nowBucket = Math.floor(Date.now() / 60_000);
    let result = await attempt(nowBucket);
    // 403 often = stale/skewed minute hash — recompute with next bucket once.
    if (result.status === 403) {
      result = await attempt(nowBucket + 1);
    }
    if (!result.streams.length) return [];

    const sorted = keepCinemaosLanguageLadders(result.streams).slice(
      0,
      MAX_STREAMS
    );
    let bestEnglishAssigned = false;
    const out: ProviderStream[] = [];
    const usedLabels = new Set<string>();

    for (const s of sorted) {
      const isBestEnglish =
        !bestEnglishAssigned && isCinemaosEnglish(`${s.name} ${s.title}`);
      if (isBestEnglish) bestEnglishAssigned = true;
      let label = cinemaosStreamLabel(s, { isBestEnglish });
      if (usedLabels.has(label)) {
        label = `${label} ${usedLabels.size + 1}`;
      }
      usedLabels.add(label);
      out.push({
        url: s.url,
        quality: s.quality,
        label,
        provider: "CinemaOS",
        type: "mp4",
        referer: `${REFERER_ORIGIN}/`,
        origin: REFERER_ORIGIN,
        userAgent: DEFAULT_UA,
      });
    }
    return out;
  } catch {
    return [];
  }
}
