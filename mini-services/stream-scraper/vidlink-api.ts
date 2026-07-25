/**
 * VidLink Pro API client — decrypt token + pull direct stream URLs via curl.
 */

import nacl from "tweetnacl";
import { curlGet } from "./curl-http";

const KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
const KEY = hexToBytes(KEY_HEX);
const NONCE = new Uint8Array(24);
const API_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Origin: "https://vidlink.pro",
  Referer: "https://vidlink.pro/",
  Accept: "application/json",
};

export interface VidlinkStream {
  url: string;
  quality: string;
  label: string;
  score: number;
}

export interface VidlinkSession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders: Record<string, string>;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encryptToken(mediaId: string): string {
  const timestamp = Math.floor(Date.now() / 1000) + 480;
  const idBytes = new TextEncoder().encode(mediaId);
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(timestamp), false);
  const payload = new Uint8Array(idBytes.length + 8);
  payload.set(idBytes);
  payload.set(ts, idBytes.length);
  const boxed = nacl.secretbox(payload, NONCE, KEY);
  const full = new Uint8Array(24 + boxed.length);
  full.set(NONCE);
  full.set(boxed, 24);
  return Buffer.from(full).toString("base64url");
}

function scoreUrl(url: string): number {
  if (url.includes(".m3u8")) return 100;
  if (url.includes(".mpd")) {
    if (url.includes("h265") || url.includes("hevc")) return 80;
    return 95;
  }
  if (url.includes("/h265/") || url.includes("h265")) return 15;
  if (url.includes(".mp4") && !url.includes(".srt")) return 92;
  return 30;
}

function extractUrls(data: unknown): VidlinkStream[] {
  const found: VidlinkStream[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === "string") {
      if (
        node.startsWith("http") &&
        !node.includes(".srt") &&
        (node.includes(".m3u8") || node.includes(".mp4") || node.includes(".mpd"))
      ) {
        const label = node.includes(".m3u8") ? "HLS" : node.includes(".mpd") ? "DASH" : "MP4";
        found.push({ url: node, quality: "auto", label, score: scoreUrl(node) });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(data);
  const seen = new Set<string>();
  return found
    .filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

export async function resolveVidlinkApi(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<{ streamUrl: string; sources: VidlinkStream[]; session: VidlinkSession } | null> {
  const token = encryptToken(String(tmdbId));
  const apiUrl =
    mediaType === "tv" && season != null && episode != null
      ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=1`
      : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  // Keep under BACKGROUND_API_TIMEOUT_MS so the circuit does not open on slow verifies.
  const res = await curlGet(apiUrl, { headers: API_HEADERS, timeoutSec: 12 });
  if (!res.ok) return null;

  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    return null;
  }

  const streams = extractUrls(data);
  if (!streams.length) return null;

  const isHevc = (url: string): boolean =>
    url.includes("h265") || url.includes("hevc") || url.includes("hev1");

  // No per-URL probe here — sequential/parallel verifies were timing out the whole
  // provider under home double-hop (circuit open → missing Phoenix for TV).
  // Player segment-probe ranks live playability instead.
  const preferred = streams
    .filter((s) => !isHevc(s.url) && (s.score >= 50 || s.url.includes(".m3u8") || s.url.includes(".mpd")))
    .slice(0, 4);
  const hevcOne = streams.find((s) => isHevc(s.url));
  const verified: VidlinkStream[] = preferred.length
    ? preferred
    : streams.filter((s) => !isHevc(s.url)).slice(0, 3);
  if (hevcOne && verified.length < 3 && !verified.some((v) => isHevc(v.url))) {
    verified.push(hevcOne);
  }

  if (!verified.length) return null;

  const session: VidlinkSession = {
    referer: "https://vidlink.pro/",
    origin: "https://vidlink.pro",
    userAgent: API_HEADERS["User-Agent"],
    cookies: "",
    extraHeaders: {
      referer: "https://vidlink.pro/",
      origin: "https://vidlink.pro",
    },
  };

  return {
    streamUrl: verified[0].url,
    sources: verified,
    session,
  };
}