import { createHlsSession } from "@/lib/hls-session";
import { buildPlaybackProxyUrl } from "@/lib/hls-proxy";
import {
  getCachedRawScrape,
  rawScrapeCacheKey,
  RAW_SCRAPE_PARTIAL_TTL_MS,
  setCachedRawScrape,
} from "@/lib/server-cache";
import { sourceId } from "./server-names";
import { dedupePlaybackSources, sourceInstanceId } from "./source-identity";
import { pickDefaultSource } from "./source-quality";
import type { PlaybackProvider, PlaybackRequest, PlaybackResponse, PlaybackSource } from "./types";

const SCRAPER_BASE = process.env.SCRAPER_URL || "http://localhost:3030/scrape";
/**
 * Full path client/server budget — API providers + light probe, not Playwright.
 * PW stays background; do not block UX for 130s.
 */
export const FULL_FETCH_TIMEOUT_MS = 30_000;
/** Fast path budget — API providers only (vixsrc/vidlink/notorrent/cinemaos/cinepro). */
export const FAST_FETCH_TIMEOUT_MS = 8_000;

interface ScraperSession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders?: Record<string, string>;
}

export interface ScraperSourceEntry {
  url: string;
  quality: string;
  label: string;
  provider: string;
  session: ScraperSession;
  verified?: boolean;
  /** Real quality capture from the mini-service (full scrape only) — see quality-probe.ts there. */
  type?: "hls" | "mp4" | "dash";
  /** 0 = probed but unknown; undefined = mini-service never classified this URL (e.g. fast path). */
  maxHeight?: number;
  ladder?: number[];
  qualitySource?: "manifest" | "label" | "probe" | "unknown";
  /** Manifest-declared bits/sec at maxHeight — separates same-height releases. */
  bitrateBps?: number;
  qualityRungs?: { height: number; url: string; bitrateBps?: number }[];
  probe?: {
    ok: boolean;
    ttfbMs: number;
    bytesPerSec: number;
    speedScore: number;
    error?: string;
  };
}

interface ScraperResult {
  streamUrl: string | null;
  sources: ScraperSourceEntry[];
  error?: string;
  partial?: boolean;
}

function streamTypeFrom(
  label: string,
  upstream: string,
  provider = "",
  quality = ""
): "hls" | "mp4" | "dash" {
  const lower = upstream.toLowerCase();
  const lbl = label.toLowerCase();
  const prov = provider.toLowerCase();
  const q = quality.toLowerCase();

  if (lbl === "dash" || lower.includes(".mpd") || q === "dash") return "dash";

  // Fshare / progressive CinePro rungs are MP4 through /v1/proxy — NOT HLS.
  // Mis-labeling them as hls leaves hls.js stuck on "Resolving stream…".
  if (
    prov.includes("fshare") ||
    lbl.startsWith("share") ||
    q === "mp4" ||
    q === "file"
  ) {
    return "mp4";
  }

  // CinePro proxy: HLS for VixSrc/Icefy/etc., not a blanket "always hls".
  if (lower.includes("/v1/proxy") || lower.includes("cinepro")) {
    if (lower.includes(".mp4") && !lower.includes(".m3u8")) return "mp4";
    if (lower.includes(".mpd")) return "dash";
    // Default proxy to HLS (VixSrc, Icefy masters).
    return "hls";
  }

  const isHls =
    lbl === "hls" ||
    lbl === "luna" ||
    lower.includes(".m3u8") ||
    lower.includes("/playlist/") ||
    lower.includes("vixsrc") ||
    lower.includes("vid1.php") ||
    lower.includes("/hls/") ||
    lower.includes("index.m3u8") ||
    lower.includes("ironbubble") ||
    lower.includes("ironwallnet") ||
    lower.includes("frygarden") ||
    lower.includes("moon.ironbubble");

  if (isHls) return "hls";

  try {
    const path = new URL(upstream).pathname.toLowerCase();
    if (path.endsWith(".mp4") && !lower.includes(".m3u8")) return "mp4";
  } catch {
    if (/\.mp4(?:\?|$)/i.test(upstream) && !lower.includes(".m3u8")) {
      return "mp4";
    }
  }

  return "hls";
}

/**
 * Token-only height from quality/label/url. maxHeight ≤0 from the scraper is
 * "probed unknown" — fall through here so "1080p" / `/1080/` still resolve.
 * Returns undefined when no token is present (do not invent 0).
 */
function maxHeightFromQuality(
  quality: string,
  label: string,
  url = ""
): number | undefined {
  const text = `${quality} ${label} ${url}`.toLowerCase();
  if (/\b2160p\b|\b4k\b/.test(text)) return 2160;
  if (/\b1440p\b/.test(text)) return 1440;
  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b720p\b/.test(text)) return 720;
  if (/\b480p\b/.test(text)) return 480;
  if (/\b360p\b/.test(text)) return 360;
  const m = text.match(/(\d{3,4})p/);
  if (m) return Number(m[1]);
  const pathToken = text.match(
    /[\/_-](2160|1440|1080|720|480|360)p?(?:[\/_.?&-]|$)/
  );
  if (pathToken) return Number(pathToken[1]);
  return undefined;
}

export function detectCodec(upstream: string): "h264" | "hevc" | "av1" | "unknown" {
  const u = upstream.toLowerCase();
  if (/av01|(?:^|[^a-z0-9])av1(?:[^a-z0-9]|$)/.test(u)) return "av1";
  if (u.includes("h265") || u.includes("hevc") || u.includes("hev1")) return "hevc";
  if (u.includes("h264") || u.includes("avc1") || u.includes("/avc")) return "h264";
  return "unknown";
}

export function toPlaybackSource(entry: ScraperSourceEntry, proxyUrl: string): PlaybackSource {
  // Prefer positive probed maxHeight + ladder top. Explicit 0 ("probed unknown")
  // must not block quality/label/url token parse.
  const ladder = entry.ladder && entry.ladder.length ? entry.ladder : undefined;
  const ladderTop =
    ladder && ladder[0] != null && ladder[0] > 0 ? ladder[0] : 0;
  const probed =
    entry.maxHeight != null && entry.maxHeight > 0 ? entry.maxHeight : 0;
  let maxHeight = Math.max(ladderTop, probed);
  if (maxHeight <= 0) {
    maxHeight =
      maxHeightFromQuality(entry.quality, entry.label, entry.url) ?? 0;
  }
  const type = entry.type ?? streamTypeFrom(entry.label, entry.url, entry.provider, entry.quality);
  const codec = detectCodec(entry.url);
  const baseId = sourceId(entry.provider, entry.label);
  return {
    id: sourceInstanceId(baseId, entry.url),
    url: proxyUrl,
    provider: entry.provider,
    quality: entry.quality || "auto",
    label: entry.label,
    type,
    // Stamp 0 only when still unknown so clients treat it as unknown tier.
    ...(maxHeight > 0 ? { maxHeight } : entry.maxHeight != null ? { maxHeight: 0 } : {}),
    ...(ladder ? { ladder } : {}),
    ...(entry.qualitySource ? { qualitySource: entry.qualitySource } : {}),
    ...(entry.bitrateBps != null && entry.bitrateBps > 0
      ? { bitrateBps: entry.bitrateBps }
      : {}),
    ...(entry.qualityRungs?.length ? { qualityRungs: entry.qualityRungs } : {}),
    ...(codec !== "unknown" ? { codec } : {}),
    ...(entry.verified === false ? { verified: false } : entry.verified === true ? { verified: true } : {}),
    ...(entry.probe
      ? {
          probe: {
            ok: entry.probe.ok,
            ttfbMs: entry.probe.ttfbMs,
            bytesPerSec: entry.probe.bytesPerSec,
            speedScore: entry.probe.speedScore,
          },
        }
      : {}),
  };
}

export const ScraperPlaybackProvider: PlaybackProvider = {
  id: "scraper",
  name: "Web scraper (Luna / Solstice / Phoenix / Nova / Pulse / Orion…)",

  async resolve(req: PlaybackRequest): Promise<PlaybackResponse> {
    const params = new URLSearchParams({
      tmdbId: String(req.tmdbId),
      mediaType: req.mediaType,
    });
    if (req.mediaType === "tv") {
      params.set(
        "season",
        String(req.season != null && Number.isFinite(req.season) ? req.season : 1)
      );
      params.set(
        "episode",
        String(req.episode != null && Number.isFinite(req.episode) ? req.episode : 1)
      );
    }
    if (req.fast) params.set("fast", "1");
    if (req.noCache) params.set("nocache", "1");
    if (req.contentClass === "anime") params.set("contentClass", "anime");
    // Preferred quality → scraper ranking (never blocks TTFF; ranking only).
    // Auto hunts 4K; an explicit 1080 profile stays at 1080. Ranking only.
    params.set(
      "qualityHint",
      String(
        req.qualityHint != null && req.qualityHint !== "auto"
          ? req.qualityHint
          : 2160
      )
    );

    const scraperUrl = req.fast
      ? SCRAPER_BASE.replace(/\/scrape$/, "/prefetch")
      : SCRAPER_BASE;

    // Cross-user raw-result cache: the scrape itself (up to ~52s Playwright) is
    // identical for every user asking about this title/season/episode/pass — only
    // the per-user HLS session + proxy URLs minted below need to be user-scoped.
    const rawKey = rawScrapeCacheKey(
      req.mediaType,
      req.tmdbId,
      req.season,
      req.episode,
      req.fast,
      req.qualityHint,
      req.contentClass
    );

    try {
      let data = req.noCache ? null : getCachedRawScrape<ScraperResult>(rawKey);

      if (!data) {
        const res = await fetch(`${scraperUrl}?${params.toString()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(req.fast ? FAST_FETCH_TIMEOUT_MS : FULL_FETCH_TIMEOUT_MS),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return {
            status: "error",
            message: `Scraper service returned ${res.status}. ${text.slice(0, 200)}`,
            providerId: "scraper",
          };
        }

        data = (await res.json()) as ScraperResult;
        // Cross-user warm: complete results 20m; partial short so poll can re-fetch.
        // A forced recovery replaces the stale cross-user roster so the next
        // navigation cannot immediately revive the dead URLs.
        if (data.streamUrl && data.sources.length) {
          const ttl = data.partial ? RAW_SCRAPE_PARTIAL_TTL_MS : undefined;
          setCachedRawScrape(rawKey, data, ttl);
        }
      }

      if (!data.streamUrl || !data.sources.length) {
        // Fast Luna miss schedules background enrich — soft-miss, not hard failure.
        const softMiss = Boolean(data.partial || req.fast);
        return {
          status: "error",
          message: data.error || "No stream URL found for this title.",
          sources: [],
          providerId: "scraper",
          ...(softMiss ? { partial: true } : {}),
        };
      }

      // LordFlix-style full roster: ship every source, including probe-failed rows.
      // The scraper keeps them for manual switching (marked not-auto-default) and
      // the client's auto-pick / failover already prefer probe.ok, so listing them
      // only adds switchable entries — it never changes what auto-plays.
      // Preserve the complete discovered inventory. Device capability gates in
      // source-quality keep unsupported HEVC/AV1 rows visible but unselectable;
      // deleting them here made legitimate 4K disappear even on capable devices.
      const entriesForClient = data.sources;
      if (!entriesForClient.length) {
        const softMiss = Boolean(data.partial || req.fast);
        return {
          status: "error",
          message: data.error || "No playable stream for this title.",
          sources: [],
          providerId: "scraper",
          ...(softMiss ? { partial: true } : {}),
        };
      }

      const playbackSources = dedupePlaybackSources(
        entriesForClient.map((entry) => {
          const hlsSession = createHlsSession(req.userId, entry.url, entry.session);
          const proxyUrl = buildPlaybackProxyUrl(hlsSession);
          const qualityRungs = entry.qualityRungs
            ?.filter((rung) => rung.height > 0 && rung.url)
            .map((rung) => {
              const rungSession = createHlsSession(
                req.userId,
                rung.url,
                entry.session
              );
              return {
                height: rung.height,
                url: buildPlaybackProxyUrl(rungSession),
                ...(rung.bitrateBps && rung.bitrateBps > 0
                  ? { bitrateBps: rung.bitrateBps }
                  : {}),
              };
            });
          return toPlaybackSource(
            { ...entry, ...(qualityRungs?.length ? { qualityRungs } : {}) },
            proxyUrl
          );
        })
      );

      // Single ranking path — honor qualityHint / preferred height (HD floor).
      const heightPref =
        req.qualityHint === "auto" || req.qualityHint == null
          ? ("auto" as const)
          : req.qualityHint;
      const defaultProxy =
        pickDefaultSource(playbackSources, null, heightPref) ?? playbackSources[0];

      return {
        status: "available",
        streamUrl: defaultProxy.url,
        sources: playbackSources,
        providerId: "scraper",
        ...(data.partial || req.fast ? { partial: true } : {}),
      };
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        // Soft timeout — client treats partial as progressive hunt, not hard empty.
        return {
          status: "error",
          message: req.fast
            ? "Fast sources still loading…"
            : "Still searching for more sources…",
          sources: [],
          providerId: "scraper",
          partial: true,
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return {
        status: "error",
        message: `Couldn't reach the scraper service. (${message})`,
        providerId: "scraper",
      };
    }
  },
};
