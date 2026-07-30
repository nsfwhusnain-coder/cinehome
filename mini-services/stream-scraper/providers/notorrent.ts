import { lookupTmdb } from "./tmdb-lookup";
import { isPoisonStreamUrl } from "../poison-url";
import type { ProviderStream } from "./types";

/**
 * Cap on streams kept per title. The addon can return 15+; every one costs a
 * verification round trip downstream (filterVerifiedEntries), so this is bounded
 * well below the response size while still being a real roster rather than a
 * single pick.
 */
const MAX_NOTORRENT_SOURCES = 8;

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

    /**
     * Keep a roster, not a single pick.
     *
     * This used to end with `out.find(m3u8) ?? out[0]` and return exactly ONE
     * stream. The addon routinely returns 9-15 eligible streams per title —
     * measured on anime, where it is often the only non-debrid provider that has
     * the title at all: Death Note 12, One Piece 12, Demon Slayer 15, Attack on
     * Titan 9 — so 8-14 usable sources per title were being discarded at the
     * last line of the resolver. That is a large part of why TV and anime
     * rosters looked so thin.
     *
     * Ordering matters as much as the count:
     *  - non-poison first. The single stream this used to return was frequently
     *    on hostingersite.com, which is in our OWN poison list, so the one
     *    source we kept was one the ranker would then refuse to auto-play.
     *  - then HLS over progressive, then real quality.
     */
    const seen = new Set<string>();
    const ranked = out
      .filter((s) => {
        const key = s.url.split("?")[0] ?? s.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const aPoison = isPoisonStreamUrl(a.url) ? 1 : 0;
        const bPoison = isPoisonStreamUrl(b.url) ? 1 : 0;
        if (aPoison !== bPoison) return aPoison - bPoison;
        const aHls = a.url.includes(".m3u8") ? 1 : 0;
        const bHls = b.url.includes(".m3u8") ? 1 : 0;
        if (aHls !== bHls) return bHls - aHls;
        return qualityRank(b.quality) - qualityRank(a.quality);
      })
      .slice(0, MAX_NOTORRENT_SOURCES);

    /**
     * Distinct labels are required, not cosmetic: `entryIdentity` in the scraper
     * and `sourceIdentity` on the client both key on provider|label, so leaving
     * every row as plain "Pulse" would collapse the whole roster back to one
     * entry downstream. The numbered form is the convention the naming layer
     * already understands (parseLabelToken -> token "pulse" + instance).
     */
    const labelled = ranked.map((s, i) => ({
      ...s,
      label: i === 0 ? "Pulse" : `Pulse ${i + 1}`,
    }));

    console.log(
      `[notorrent] ${labelled.length} stream(s) for ${tmdbId} (from ${out.length} eligible)`
    );
    return labelled;
  } catch {
    return [];
  }
}