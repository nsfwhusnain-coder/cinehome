/**
 * Vidrock HTTP provider — AES-GCM decrypt of /api/movie|tv JSON.
 *
 * English servers return HLS masters (often 1080/720/480/360) or an Astra
 * JSON MP4 ladder. Strong anime coverage on TMDB TV ids. Kill with
 * PROVIDER_VIDROCK=0.
 */

import { createDecipheriv } from "node:crypto";
import type { ProviderStream, QualityRung } from "./types";
import { isPoisonStreamUrl } from "../poison-url";

const API_BASE = "https://vidrock.net/api";
const REFERER = "https://vidrock.net/";
const ORIGIN = "https://vidrock.net";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const KEY_HEX =
  "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const TIMEOUT_MS = 12_000;
const PLAYLIST_TIMEOUT_MS = 8_000;
const MAX_STREAMS = 4;
const MAX_RUNGS = 6;
const LABEL_BASE = "Rock";
const PROVIDER_NAME = "Vidrock";

export const VIDROCK_TIMEOUT_MS = TIMEOUT_MS;
export const VIDROCK_OUTER_TIMEOUT_MS = 14_000;
export const VIDROCK_MAX_STREAMS = MAX_STREAMS;
export const VIDROCK_KEY_HEX = KEY_HEX;

const API_HEADERS: Record<string, string> = {
  "User-Agent": DEFAULT_UA,
  Origin: ORIGIN,
  Referer: REFERER,
  Accept: "application/json, text/plain, */*",
};

interface VidrockSlot {
  url?: string | null;
  type?: string | null;
  language?: string;
  flag?: string;
}

interface PlaylistRung {
  resolution?: number;
  url?: string;
}

export function decodeVidrockBase64Url(raw: string): Buffer {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 2 ? "==" : padded.length % 4 === 3 ? "=" : "";
  return Buffer.from(padded + pad, "base64");
}

export function decryptVidrockCiphertext(raw: string): string {
  const buf = decodeVidrockBase64Url(raw.trim());
  if (buf.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("vidrock_ciphertext_short");
  }
  const iv = buf.subarray(0, GCM_IV_BYTES);
  const rest = buf.subarray(GCM_IV_BYTES);
  const tag = rest.subarray(rest.length - GCM_TAG_BYTES);
  const ciphertext = rest.subarray(0, rest.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(KEY_HEX, "hex"),
    iv
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}

export function isVidrockEnglishSlot(
  name: string,
  slot: Pick<VidrockSlot, "language" | "flag">
): boolean {
  const label = name.trim().toLowerCase();
  const language = (slot.language || "").trim().toLowerCase();
  if (label === "hindi" || language === "hi" || language.includes("hindi")) {
    return false;
  }
  if (!language) return true;
  return (
    language === "en" ||
    language === "us" ||
    language === "english" ||
    language.includes("english")
  );
}

export function detectVidrockStreamType(
  url: string,
  type?: string | null
): "hls" | "mp4" | "dash" {
  const hint = (type || "").toLowerCase();
  const lower = url.toLowerCase();
  if (hint === "dash" || lower.includes(".mpd")) return "dash";
  if (hint === "hls" || lower.includes(".m3u8") || lower.includes("/master")) {
    return "hls";
  }
  return "mp4";
}

export function looksLikeDirectMediaUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes(".mpd") ||
    /\.mp4(?:\?|$)/i.test(lower)
  );
}

export function parseVidrockPlaylist(raw: unknown): QualityRung[] {
  if (!Array.isArray(raw)) return [];
  const rungs: QualityRung[] = [];
  const seen = new Set<number>();
  for (const item of raw as PlaylistRung[]) {
    const height = Number(item.resolution);
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url || !Number.isFinite(height) || height <= 0 || seen.has(height)) {
      continue;
    }
    if (isPoisonStreamUrl(url)) continue;
    seen.add(height);
    rungs.push({ height, url });
  }
  return rungs.sort((a, b) => b.height - a.height).slice(0, MAX_RUNGS);
}

function qualityFromHeight(height: number): string {
  return height > 0 ? `${height}p` : "auto";
}

async function fetchJson(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function expandPlaylist(url: string): Promise<QualityRung[]> {
  try {
    const res = await fetchJson(url, PLAYLIST_TIMEOUT_MS);
    if (!res.ok) return [];
    return parseVidrockPlaylist(JSON.parse(res.text));
  } catch {
    return [];
  }
}

function streamFromResolved(
  label: string,
  typeHint: string | null | undefined,
  mediaUrl: string,
  rungs: QualityRung[]
): ProviderStream | null {
  const ordered = rungs.length
    ? rungs
    : looksLikeDirectMediaUrl(mediaUrl)
      ? []
      : null;
  if (ordered === null) return null;
  const best = ordered[0];
  const url = best?.url || mediaUrl;
  if (!url || isPoisonStreamUrl(url)) return null;
  const streamType = detectVidrockStreamType(url, typeHint);
  const maxHeight = best?.height;
  const ladder = ordered.map((rung) => rung.height);
  return {
    url,
    quality: qualityFromHeight(maxHeight ?? 0),
    label,
    provider: PROVIDER_NAME,
    type: streamType,
    referer: REFERER,
    origin: ORIGIN,
    userAgent: DEFAULT_UA,
    ...(maxHeight ? { maxHeight } : {}),
    ...(ladder.length ? { ladder, qualityRungs: ordered } : {}),
  };
}

function rankStream(stream: ProviderStream): number {
  const parsedQuality = parseInt(stream.quality, 10);
  const height =
    stream.maxHeight ?? (Number.isFinite(parsedQuality) ? parsedQuality : 0);
  const typeBonus = stream.type === "hls" ? 4000 : stream.type === "mp4" ? 1000 : 0;
  const rungBonus = (stream.qualityRungs?.length ?? 0) * 10;
  return height + typeBonus + rungBonus;
}

/**
 * Resolve Vidrock English servers. Empty = title miss, not an outage.
 */
export async function resolveVidrock(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<ProviderStream[]> {
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return [];
  const path =
    mediaType === "tv" && season != null && episode != null
      ? `tv/${tmdbId}/${season}/${episode}`
      : `movie/${tmdbId}`;
  try {
    const res = await fetchJson(`${API_BASE}/${path}`, TIMEOUT_MS);
    if (!res.ok) return [];
    const data = JSON.parse(res.text) as Record<string, VidrockSlot>;
    if (!data || typeof data !== "object") return [];

    const candidates: ProviderStream[] = [];
    for (const [name, slot] of Object.entries(data)) {
      if (!slot?.url || !isVidrockEnglishSlot(name, slot)) continue;
      let plain: string;
      try {
        plain = decryptVidrockCiphertext(slot.url).trim();
      } catch {
        continue;
      }
      if (!plain.startsWith("http")) continue;
      const rungs = looksLikeDirectMediaUrl(plain)
        ? []
        : await expandPlaylist(plain);
      const stream = streamFromResolved(LABEL_BASE, slot.type, plain, rungs);
      if (stream) candidates.push(stream);
    }

    const ranked = candidates.sort((a, b) => rankStream(b) - rankStream(a));
    const out: ProviderStream[] = [];
    const seen = new Set<string>();
    for (const stream of ranked) {
      if (seen.has(stream.url) || out.length >= MAX_STREAMS) continue;
      seen.add(stream.url);
      const label = out.length === 0 ? LABEL_BASE : `${LABEL_BASE} ${out.length + 1}`;
      out.push({ ...stream, label });
    }
    return out;
  } catch {
    return [];
  }
}
