import { lookupTmdb } from "./tmdb-lookup";
import type { ProviderStream } from "./types";

const NOTORRENT_API = "https://addon-osvh.onrender.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanText(str: string): string {
  return str.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, "").trim();
}

function qualityRank(quality: string): number {
  const q = quality.toLowerCase();
  if (q.includes("2160") || q.includes("4k")) return 100;
  if (q.includes("1080")) return 80;
  if (q.includes("720")) return 60;
  if (q.includes("480")) return 40;
  return 20;
}

function extractQuality(title: string): string {
  const match = title.match(/(\d{3,4}p)/i);
  if (match) return match[1].toLowerCase();
  if (title.toUpperCase().includes("4K")) return "2160p";
  return "auto";
}

export async function resolveNotorrent(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<ProviderStream[]> {
  const info = await lookupTmdb(tmdbId, mediaType);
  if (!info?.imdbId) return [];

  const apiUrl =
    mediaType === "tv" && season != null && episode != null
      ? `${NOTORRENT_API}/stream/series/${info.imdbId}:${season}:${episode}.json`
      : `${NOTORRENT_API}/stream/movie/${info.imdbId}.json`;

  try {
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      streams?: {
        url?: string;
        title?: string;
        externalUrl?: string;
        behaviorHints?: {
          headers?: Record<string, string>;
          proxyHeaders?: { request?: Record<string, string> };
        };
      }[];
    };

    const out: ProviderStream[] = [];
    for (const item of data.streams ?? []) {
      if (!item.url || item.externalUrl) continue;
      if (item.url.includes("github.com") || item.url.includes("googleusercontent")) continue;

      const title = cleanText(item.title || "");
      const quality = extractQuality(title);
      const proxyHeaders = item.behaviorHints?.proxyHeaders?.request ?? {};
      const headers = { ...(item.behaviorHints?.headers ?? {}), ...proxyHeaders };

      out.push({
        url: item.url,
        quality,
        label: "Pulse",
        provider: "NoTorrent",
        referer: headers.Referer || headers.referer || "",
        origin: headers.Origin || headers.origin || "",
        userAgent: headers["User-Agent"] || headers["user-agent"] || UA,
      });
    }

    out.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    const best = out.find((s) => s.url.includes(".m3u8")) ?? out[0];
    console.log(`[notorrent] ${best ? 1 : 0} stream(s) for ${tmdbId}`);
    return best ? [best] : [];
  } catch {
    return [];
  }
}