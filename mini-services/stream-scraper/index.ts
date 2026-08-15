/**
 * CineHome Stream Scraper — multi-provider stream resolver.
 * Luna-first (Vixsrc) fast path, then API providers + parallel Playwright embeds.
 * Captures direct m3u8/mp4/mpd URLs plus auth context for the HLS proxy.
 */

import { chromium, type Browser } from "playwright";
import { createServer } from "http";
import { AsyncLocalStorage } from "node:async_hooks";
import { URL } from "url";
import { resolveVidlinkApi } from "./vidlink-api";
import { curlGet } from "./curl-http";
import { resolveVixsrc } from "./providers/vixsrc";
import { resolveNotorrent } from "./providers/notorrent";
import { lookupTmdb } from "./providers/tmdb-lookup";
import {
  resolveCinepro,
  isCineproConfigured,
  dedupeCineproVixsrcAgainstNative,
  CINEPRO_FAST_TIMEOUT_MS,
  CINEPRO_FULL_TIMEOUT_MS,
} from "./providers/cinepro";
import { startCineproWarmer } from "./providers/cinepro-warmer";
import {
  resolveCinemaos,
  CINEMAOS_OUTER_TIMEOUT_MS,
} from "./providers/cinemaos";
import {
  resolveVideasy,
  VIDEASY_OUTER_TIMEOUT_MS,
} from "./providers/videasy";
import {
  resolveVidrock,
  VIDROCK_OUTER_TIMEOUT_MS,
} from "./providers/vidrock";
import {
  canAttempt,
  getAllCircuitSnapshots,
  isProviderEnabled,
  recordFailure,
  recordSuccess,
  withCircuit,
  type ProviderId,
} from "./providers/circuit";
import type { ProviderStream } from "./providers/types";
import {
  getLastProbeSummary,
  isKnownTruncatedSource,
  probeSourceBatch,
  type ProbeResult,
} from "./probe";
import {
  probeSourceQuality,
  isHlsMasterManifest,
  inferHeightFromUrl,
  type QualityProbeEntry,
  type QualitySource,
} from "./quality-probe";
import {
  candidateMasterUrls,
  normalizeStreamUrl,
  selectEmbedCaptures,
  looksLikeHlsMasterUrl,
} from "./capture-select";
import { isEmbedHostDead, isHardEmbedFailure, recordEmbedOutcome } from "./providers/embed-health";
import {
  hasStreamExtension,
  isCaptureWorthySize,
  isLikelyVideoMime,
  labelFromMime,
} from "./providers/stream-mime";
import { isDebugEnabled, recordDebugCapture, flushDebugDump } from "./debug-dump";
import { raceWithHardTimeout } from "./enrich-timeout";
import { raceProviderArms } from "./provider-race";
import { filterHighQualitySources } from "./quality-floor";
import {
  effectiveMaxHeight as rankEffectiveMaxHeight,
  pickFactDefaultUrl as rankPickFactDefaultUrl,
  sortSourcesForDefault as rankSortSourcesForDefault,
} from "./default-source-rank";
import {
  isNeverAutoDefaultSource,
  isPreviewOrSampleUrl,
  POISON_SCORE_PENALTY,
} from "./poison-url";
import {
  type EmbedSourceSpec,
  buildPrimarySourceUrls,
  buildSecondarySourceUrls,
  PW_WAIT_MS,
  ENRICH_HARD_TIMEOUT_MS,
  SECONDARY_MIN_REMAINING_MS,
  VERIFIED_MIN_SKIP_SECONDARY,
} from "./embed-roster";
import {
  EARLY_EXIT_POLL_MS,
  EARLY_EXIT_TARGET_CAPTURES,
  countGoodEarlyCaptures,
  isGoodEarlyCapture,
  shouldEarlyExitWait,
} from "./capture-early-exit";
import { browserPoolSize } from "./browser-pool-config";
import {
  countAutoPlayableRosterSources,
  countMeasuredPlayableRosterSources,
  partialForPlayableRoster,
  rosterHasPlayableHeight,
  shouldSkipPlaywrightForHealthyRoster,
} from "./roster-health";
import { appendNewSourceIdentities } from "./progressive-merge";
import { parseContentClassParam, resultCacheKey } from "./result-cache-key";
import { capRosterWithQualityReserve } from "./quality-roster-cap";
import { mergeDistinctStreamEntries } from "./source-entry-merge";
import {
  coalescedEnrichmentKey,
  EnrichmentCoalescer,
} from "./enrich-coalescer";

const PORT = 3030;
/**
 * Shared Playwright pool — env BROWSER_POOL_SIZE (min 1, max 4), default 1.
 * The active primary wave has one measured high-yield host. Concurrent title
 * enrichment queues in the shared pool instead of multiplying background CPU.
 * Operators can override within the tested 2..6 envelope.
 */
const MAX_BROWSERS = browserPoolSize(process.env.BROWSER_POOL_SIZE);
/** Default goto budget; per-embed specs override for flaky hosts. Cap 10s per provider intent. */
const PAGE_TIMEOUT = 10_000;
/** Long enough for queued embed workers (MAX_BROWSERS concurrent, rest wait). */
const POOL_WAIT_TIMEOUT = 120000;
/** 30 min result cache — popular titles stay warm across users. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const VIXSRC_TIMEOUT_MS = 10000;
/** VidLink/secondary may need a bit longer after parallel verifies. */
const BACKGROUND_API_TIMEOUT_MS = 18000;
const HLS_CACHE_TTL_MS = 3 * 60 * 1000;
/** Keep a proven 4K roster warm so the next play is not a coin-flip race. */
const FOUR_K_ROSTER_TTL_MS = 15 * 60 * 1000;
/** Ultra miss — retry soon instead of locking a 1080-only roster for 30 min. */
const ULTRA_MISS_TTL_MS = 75_000;
/** Hard cap returned to clients — higher for TV multi-server switching. */
const MAX_SOURCES = 20;
const QUALITY_DISCOVERY_RESERVED_SLOTS = 4;
/** Keep hunting until this many unique servers (LordFlix-style roster). */
/** Hunt / soft-keep target — keep enriching toward this when under cap. */
const MIN_SOURCES_TARGET = 14;
/**
 * Stop advertising `partial: true` once we have this many sources.
 * Keep low so the client stops "searching for more…" while PW still runs in bg.
 */
const PARTIAL_CLEAR_MIN = 2;
const VERIFY_TIMEOUT_SEC = 12;
/** Keep alternate CDNs per embed host instead of discarding after the first. */
const MAX_CAPTURES_PER_EMBED = 3;
/** Max playlist URLs kept from VidLink API (distinct labels / multiLang). */
const MAX_VIDLINK_API_SOURCES = 5;
/** At most one HEVC/h265 stream kept as last-resort when no H264 for that identity. */
const MAX_HEVC_FALLBACK_SOURCES = 1;

/** SCRAPER_LOG_LEVEL=debug|info|warn|error (default info). */
type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw || "info").trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

const ACTIVE_LOG_LEVEL = parseLogLevel(process.env.SCRAPER_LOG_LEVEL);

function logAt(level: LogLevel, message: string, ...args: unknown[]): void {
  if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[ACTIVE_LOG_LEVEL]) return;
  if (level === "error") console.error(message, ...args);
  else if (level === "warn") console.warn(message, ...args);
  else console.log(message, ...args);
}

interface ProviderTiming {
  provider: ProviderId;
  ms: number;
  ok: boolean;
  at: number;
  error?: string;
}

/** Last scrape wall timings (fast path / full). */
interface ScrapeTimingSnapshot {
  at: number;
  key: string;
  fast: boolean;
  totalMs: number;
  providers: ProviderTiming[];
}

let lastScrapeTiming: ScrapeTimingSnapshot | null = null;

/** Lifecycle metrics for /health — fast vs full counts, enrich timing, filter diagnostics. */
let lastScrapeLifecycle: {
  lastEnrichMs: number | null;
  lastEnrichSources: number | null;
  lastEnrichAt: number | null;
  lastFastSources: number | null;
  lastFullSources: number | null;
  lastReturnedSources: number | null;
  lastPartial: boolean | null;
  lastKey: string | null;
  lastTotalMs: number | null;
  pwWaitMs: number;
  enrichHardTimeoutMs: number;
} = {
  lastEnrichMs: null,
  lastEnrichSources: null,
  lastEnrichAt: null,
  lastFastSources: null,
  lastFullSources: null,
  lastReturnedSources: null,
  lastPartial: null,
  lastKey: null,
  lastTotalMs: null,
  pwWaitMs: PW_WAIT_MS,
  enrichHardTimeoutMs: ENRICH_HARD_TIMEOUT_MS,
};

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface StreamCapture {
  url: string;
  quality: string;
  label: string;
  referer: string;
  origin: string;
  userAgent: string;
  score: number;
  /** Set when a bounded manifest peek confirms multi-rendition master. */
  isMaster?: boolean;
}

interface StreamSession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders: Record<string, string>;
}

interface SourceEntry {
  url: string;
  quality: string;
  label: string;
  provider: string;
  session: StreamSession;
  /** Measured latency probe (full scrape only). */
  probe?: ProbeResult;
  /**
   * False when soft-kept after failed segment verify (dead proxy / flake).
   * Undefined/true = treated as verified for default-pick ranking.
   */
  verified?: boolean;
  /** Real quality capture (full scrape only) — see quality-probe.ts. Undefined = not yet probed. */
  type?: "hls" | "mp4" | "dash";
  /** 0 = probed but unknown; undefined = never probed (e.g. fast path). */
  maxHeight?: number;
  /** Desc-sorted rendition heights from an HLS/DASH master; empty/undefined for single-rendition or mp4. */
  ladder?: number[];
  /** Provenance of maxHeight/ladder — optional, additive for clients. */
  qualitySource?: QualitySource;
  /** Declared bitrate for the rendition at maxHeight, when present in a manifest. */
  bitrateBps?: number;
  /** Alternate progressive URLs on this source (one host, many heights). */
  qualityRungs?: { height: number; url: string; bitrateBps?: number }[];
  audioLanguage?: string;
}

interface ScrapeResult {
  streamUrl: string | null;
  sources: SourceEntry[];
  error?: string;
  /** True when background enrich may still add sources. */
  partial?: boolean;
}


function cacheTtlFor(url: string): number {
  const normal = url.includes(".m3u8") ? HLS_CACHE_TTL_MS : CACHE_TTL_MS;
  try {
    const parsed = new URL(url);
    const expires = parsed.searchParams.get("expires");
    if (expires) {
      const expSec = Number(expires);
      if (Number.isFinite(expSec)) {
        const signedTtl = expSec * 1000 - Date.now() - 60_000;
        if (signedTtl <= 0) return 0;
        return Math.min(normal, signedTtl);
      }
    }
  } catch {
    /* ignore */
  }
  return normal;
}


/**
 * LordFlix-style chip names for embed captures.
 * (enc-dec Lordflix API is dead — these Playwright embeds are the replacement roster.)
 */
const EMBED_SERVER_LABELS: Record<string, string> = {
  Vidking: "Solstice",
  "Embed.su": "Nova",
  VidLink: "Phoenix",
  Vidsrc: "Orion",
  VidsrcRU: "Lion",
  VidsrcSU: "Sakura",
  VidsrcRip: "Flower",
  "2Embed": "Astra",
  "2EmbedOrg": "Ativa",
  Multiembed: "Blaze",
  VideasyEmbed: "Quasar",
  VidNest: "Nest",
  VidJoy: "Joy",
  Smashy: "Comet",
  MoviesAPI: "Rio",
  AutoEmbed: "Moscow",
};

function providerFromEmbed(embedUrl: string): string {
  try {
    const host = new URL(embedUrl).hostname.toLowerCase();
    if (host.includes("vidking")) return "Vidking";
    if (host.includes("embed.su")) return "Embed.su";
    if (host.includes("vidlink")) return "VidLink";
    // Distinct Vidsrc mirrors → distinct LordFlix-style city chips after label map.
    if (host.includes("vidsrc-embed.ru") || host === "vidsrc-embed.ru") return "VidsrcRU";
    if (host === "vidsrc.su" || host.endsWith(".vidsrc.su")) return "VidsrcSU";
    if (host.includes("vidsrc.rip")) return "VidsrcRip";
    if (host.includes("vidsrc.me") || host.includes("vidsrc.xyz")) return "Vidsrc";
    if (host.includes("vidsrc")) return "Vidsrc";
    if (host.includes("2embed.org")) return "2EmbedOrg";
    if (host.includes("2embed")) return "2Embed";
    if (host.includes("multiembed")) return "Multiembed";
    if (host.includes("videasy")) return "VideasyEmbed";
    if (host.includes("vidnest")) return "VidNest";
    if (host.includes("vidjoy")) return "VidJoy";
    if (host.includes("smashy")) return "Smashy";
    if (host.includes("moviesapi")) return "MoviesAPI";
    if (host.includes("autoembed")) return "AutoEmbed";
  } catch {
    /* ignore */
  }
  return "Embed";
}

function embedServerLabel(provider: string): string {
  return EMBED_SERVER_LABELS[provider] || provider;
}

function parseHeightFromMeta(url: string, label: string, quality: string): number {
  const text = `${quality} ${label} ${url}`.toLowerCase();
  if (/\b2160p\b|\b4k\b/.test(text)) return 2160;
  if (/\b1440p\b/.test(text)) return 1440;
  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b720p\b/.test(text)) return 720;
  if (/\b480p\b/.test(text)) return 480;
  const m = text.match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

function scoreSourceEntry(
  url: string,
  label: string,
  quality = "auto",
  provider = "",
  options: { nameBonus?: boolean } = {}
): number {
  const nameBonus = options.nameBonus !== false;
  let score = scoreCapture(url, label);
  const h = parseHeightFromMeta(url, label, quality);
  if (h >= 2160) score += 50;
  else if (h >= 1080) score += 35;
  else if (h >= 720) score += 20;

  const hevc = isHevcStream(url);
  const isHls = url.includes(".m3u8");
  const isDash = url.includes(".mpd");
  const isMp4 = url.includes(".mp4") && !isHls && !isDash;

  // Prefer H264 HLS; heavy penalty for hevc / h265 / mpd+h265.
  if (isHls && !hevc) score += 40;
  else if (isHls) score += 10;
  if (hevc) score -= 80;
  if (isDash && hevc) score -= 40;
  // Progressive MP4 is fine for clips but weak for long films.
  if (isMp4) score -= 10;
  if (!isHls && !isDash && !url.includes(".mp4")) score -= 60;
  // Poison / abuse hosts + trailer/sample/preview: huge penalty (rank gate is primary).
  if (isNeverAutoDefaultSource(url, label)) score -= POISON_SCORE_PENALTY;

  // Fast CDN name preference — disabled when measured probe ranks sources.
  if (nameBonus) {
    const p = provider.trim().toLowerCase();
    const l = label.trim().toLowerCase();
    if (p.includes("vidking") || l.startsWith("solstice")) score += 35;
    else if (p.includes("notorrent") || l.startsWith("pulse")) score += 15;
    else if (p === "vixsrc" || l === "luna") score += 5;
  }

  return score;
}

function entryIdentity(entry: SourceEntry): string {
  return normalizeStreamUrl(entry.url);
}

function entryScore(entry: SourceEntry): number {
  return scoreSourceEntry(entry.url, entry.label, entry.quality, entry.provider);
}

/** Soft-kept dead URLs use verified:false; everything else ranks as verified. */
function isEntryVerified(entry: SourceEntry): boolean {
  return entry.verified !== false;
}

function preferIdentityEntry(existing: SourceEntry | undefined, candidate: SourceEntry): SourceEntry {
  if (!existing) return candidate;
  const aVer = isEntryVerified(candidate) ? 1 : 0;
  const bVer = isEntryVerified(existing) ? 1 : 0;
  if (aVer !== bVer) return aVer > bVer ? candidate : existing;
  const aH = effectiveMaxHeight(candidate);
  const bH = effectiveMaxHeight(existing);
  if (aH !== bH) return aH > bH ? candidate : existing;
  return entryScore(candidate) >= entryScore(existing) ? candidate : existing;
}

function mergeSourceEntries(entries: SourceEntry[]): SourceEntry[] {
  // Drop CinePro VixSrc/Luna when native Vixsrc Luna is already present (one CDN).
  const beforeDedupe = entries.length;
  const deduped = dedupeCineproVixsrcAgainstNative(entries);
  if (deduped.length < beforeDedupe) {
    logAt(
      "info",
      `[cinepro] vixsrc dedupe: ${beforeDedupe} → ${deduped.length} (dropped CinePro/VixSrc when native Luna present)`
    );
  }

  const sorted = [...deduped]
    .filter((e) => !e.url.includes(".srt"))
    .sort((a, b) => entryScore(b) - entryScore(a));
  return mergeDistinctStreamEntries(sorted, preferIdentityEntry).sort(
    (a, b) => entryScore(b) - entryScore(a)
  );
}

/**
 * Rank VidLink API playlists: non-HEVC HLS → non-HEVC DASH/MP4 → 1 HEVC last-resort.
 * Returns up to MAX_VIDLINK_API_SOURCES for distinct Phoenix / Phoenix 2 labels.
 */
function pickVidlinkStreams(
  sources: {
    url: string;
    quality: string;
    label: string;
    score: number;
    type?: "hls" | "mp4" | "dash";
    maxHeight?: number;
    ladder?: number[];
    qualityRungs?: { height: number; url: string }[];
  }[]
): typeof sources {
  const usable = sources.filter((s) => !s.url.includes(".srt"));
  const nonHevcHls = usable
    .filter((s) => s.url.includes(".m3u8") && !isHevcStream(s.url))
    .sort((a, b) => b.score - a.score);
  const nonHevcOther = usable
    .filter(
      (s) =>
        !isHevcStream(s.url) &&
        !s.url.includes(".m3u8") &&
        (s.url.includes(".mpd") || s.url.includes(".mp4"))
    )
    .sort((a, b) => b.score - a.score);
  const hevc = usable.filter((s) => isHevcStream(s.url)).sort((a, b) => b.score - a.score);

  const picked: typeof sources = [];
  const seen = new Set<string>();
  const push = (s: (typeof sources)[number]) => {
    if (seen.has(s.url) || picked.length >= MAX_VIDLINK_API_SOURCES) return;
    seen.add(s.url);
    picked.push(s);
  };

  for (const s of nonHevcHls) push(s);
  for (const s of nonHevcOther) push(s);
  // Only when no H264/DASH/MP4 — keep one stormvv-style HEVC as last resort.
  if (picked.length === 0 && hevc.length) {
    push(hevc[0]!);
  }

  return picked;
}

function vidlinkSourceLabel(index: number): string {
  return index === 0 ? "Phoenix" : `Phoenix ${index + 1}`;
}

function embedCaptureLabel(baseLabel: string, index: number): string {
  return index === 0 ? baseLabel : `${baseLabel} ${index + 1}`;
}

/**
 * Default pick order (higher = preferred when quality similar):
 * Solstice → Pulse → Luna → Phoenix (H264 HLS) → Nova → Orion → …
 * Luna stays available for TTFF fast-path but loses to Solstice after enrich.
 */
function providerPriority(provider: string, label = "", url = ""): number {
  // Poison / trailer / sample never win provider-priority ties over clean URLs.
  if (url && isNeverAutoDefaultSource(url, label)) return -10;
  const p = provider.trim().toLowerCase();
  const l = label.trim().toLowerCase();
  // #1 Solstice — most reliable through household /api/hls (single hop).
  if (p === "vidking" || l.startsWith("solstice")) return 12;
  // CinePro — strong when segment is real video; second tier after Solstice.
  if (p.startsWith("cinepro") || p.includes("cinepro/")) {
    if (url.includes(".php")) return 4;
    if (l === "luna" || p.includes("vixsrc")) return 7;
    // Probe sniffs HLS vs progressive; /v1/proxy wraps both (Fshare MP4 ≠ HLS).
    if (url.includes(".m3u8") || url.includes("playlist")) return 10;
    return 8;
  }
  // Pulse PHP redirectors are often hotlink-403 — never rank above real m3u8.
  if (p === "notorrent" || l.startsWith("pulse")) {
    if (url.includes(".php") || url.includes("hostingersite.com")) return 3;
    if (url.includes(".m3u8") && !isHevcStream(url)) return 9;
    return 4;
  }
  if (p === "vixsrc" || l === "luna") return 8;
  // Videasy/Quasar — native 1080 MP4 ladder (Cypher). Above Luna, below Solstice.
  if (p.includes("videasy") || l === "quasar" || l.startsWith("quasar ")) {
    if (url.includes(".m3u8")) return 10;
    return 9;
  }
  if (p.includes("vidrock") || l === "rock" || l.startsWith("rock ")) {
    if (url.includes(".m3u8")) return 8;
    return 7;
  }
  // CinemaOS — progressive MP4 via worker proxies; below Solstice / CinePro HLS.
  if (p.includes("cinemaos") || l === "cinema" || l.startsWith("cinema ")) {
    if (url.includes(".m3u8")) return 8;
    return 7;
  }
  if (p.includes("vidlink") || l.startsWith("phoenix")) {
    // Demote HEVC / DASH heavily; keep H264 HLS mid-tier.
    if (isHevcStream(url) || url.includes(".mpd")) return 1;
    if (url.includes(".m3u8") && !isHevcStream(url)) return 7;
    // Progressive MP4 can play but is weaker than Luna HLS for long VOD.
    if (url.includes(".mp4") && !isHevcStream(url)) return 5;
    return 3;
  }
  if (p.includes("embed.su") || p === "embed.su" || l.startsWith("nova")) return 6;
  if (p.includes("vidsrc") || l.startsWith("orion")) return 5;
  if (p.includes("vidnest") || l.startsWith("nest")) return 5;
  if (p.includes("vidjoy") || l.startsWith("joy")) return 4;
  if (p.includes("2embed") || l.startsWith("astra")) return 4;
  if (p.includes("multiembed") || l.startsWith("blaze")) return 3;
  if (p.includes("videasyembed") || l.startsWith("quasar web")) return 3;
  return 0;
}

/** Codec/resolution score without provider-name CDN bonuses (probe path). */
function codecOnlyScore(entry: SourceEntry): number {
  return scoreSourceEntry(entry.url, entry.label, entry.quality, entry.provider, {
    nameBonus: false,
  });
}

function effectiveMaxHeight(entry: SourceEntry): number {
  return rankEffectiveMaxHeight(entry, inferHeightFromUrl);
}

/**
 * Preferred height for ranking (from the `qualityHint` query param).
 *
 * This was a module-level `let`, assigned at the top of each request and reset
 * to 0 in a `finally`. That is a race on a server that handles concurrent
 * scrapes: two in-flight requests share the single slot, so one could rank with
 * the other's target, and whichever finished first zeroed the hint while the
 * other was still ranking. Mostly invisible while every caller asked for 1080
 * (0 and 1080 both resolve to the HD floor downstream) — but it silently
 * discarded a 2160 preference, which is exactly the case that now matters:
 * some titles do carry a natively-decodable 4K debrid source.
 *
 * AsyncLocalStorage scopes the value to one request's async context instead.
 * Background enrich started inside that context inherits it deliberately, and
 * an absent store falls back to the same HD floor as before, so a runtime that
 * ever failed to propagate would degrade to today's behavior rather than break.
 */
const qualityHintStore = new AsyncLocalStorage<number>();
const contentClassStore = new AsyncLocalStorage<string | undefined>();

function currentQualityHintHeight(): number {
  return qualityHintStore.getStore() ?? 0;
}

function currentContentClass(): string | undefined {
  return contentClassStore.getStore();
}

/** Options shared by sort + pick so streamUrl matches ranked[0]. */
function defaultRankOptions() {
  return {
    qualityHintHeight: currentQualityHintHeight(),
    inferHeight: inferHeightFromUrl,
    isHevcStream,
    codecOnlyScore: (e: { url: string; label?: string; quality?: string; provider?: string }) =>
      scoreSourceEntry(e.url, e.label ?? "", e.quality ?? "auto", e.provider ?? "", {
        nameBonus: false,
      }),
    providerPriority,
    entryScore: (e: { url: string; label?: string; quality?: string; provider?: string }) =>
      scoreSourceEntry(e.url, e.label ?? "", e.quality ?? "auto", e.provider ?? ""),
    contentClass: currentContentClass(),
  };
}

/** Client-aligned HD/unknown/sub-HD tiers — see default-source-rank.ts. */
function sortSourcesForDefault(sources: SourceEntry[]): SourceEntry[] {
  return rankSortSourcesForDefault(sources, defaultRankOptions());
}

/**
 * Zero-network quality hints for fast path / pre-probe roster.
 * Only stamps maxHeight when a URL/label token is unambiguous — never invents 0.
 * Also backfills maxHeight from ladder[0] when ladder is known but maxHeight missing.
 */
function attachCheapQualityHints(sources: SourceEntry[]): SourceEntry[] {
  return sources.map((entry) => {
    // Ensure maxHeight whenever ladder[0] is known.
    if (
      (entry.maxHeight == null || entry.maxHeight <= 0) &&
      entry.ladder?.[0] != null &&
      entry.ladder[0] > 0
    ) {
      return {
        ...entry,
        maxHeight: entry.ladder[0],
        qualitySource: entry.qualitySource ?? "manifest",
      };
    }
    if (entry.maxHeight != null && entry.maxHeight > 0) {
      return entry.qualitySource
        ? entry
        : { ...entry, qualitySource: entry.ladder?.length ? "manifest" : "label" };
    }
    if (entry.ladder && entry.ladder.length > 0) return entry;
    const h = inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
    if (h <= 0) return entry;
    return {
      ...entry,
      maxHeight: h,
      qualitySource: "label" as const,
      type: entry.type ?? (entry.url.includes(".mpd") ? "dash" : entry.url.includes(".mp4") ? "mp4" : "hls"),
    };
  });
}

function pickDefaultStreamUrl(sources: SourceEntry[]): string | null {
  // Facts only. The Next app re-ranks with decidePlayback.
  return rankPickFactDefaultUrl(sources);
}

function buildMergedResult(entries: SourceEntry[], error?: string): ScrapeResult {
  // Background enrich and cache refresh can finish while duration probes run.
  // Never let either path reintroduce a preview URL that the probe just rejected.
  const durationSafeEntries = entries
    .filter((entry) => !isKnownTruncatedSource(entry.url))
    .map((entry) =>
      isNeverAutoDefaultSource(entry.url, entry.label)
        ? { ...entry, verified: false as const }
        : entry
    );
  const withHints = attachCheapQualityHints(mergeSourceEntries(durationSafeEntries));
  const qualityFiltered = filterHighQualitySources(withHints);
  const sources = capRosterWithQualityReserve(
    sortSourcesForDefault(qualityFiltered),
    MAX_SOURCES,
    QUALITY_DISCOVERY_RESERVED_SLOTS,
    currentQualityHintHeight()
  );
  if (!sources.length) {
    return { streamUrl: null, sources: [], error: error || "No stream URL found." };
  }
  return { streamUrl: pickDefaultStreamUrl(sources), sources };
}

/**
 * Full-path only: measure top candidates, attach probe, re-rank by measured speed.
 * Skipped on fast=1 (caller must not invoke).
 */
async function applyLatencyProbes(
  result: ScrapeResult,
  mediaType: "movie" | "tv",
  expectedDurationS: number
): Promise<ScrapeResult> {
  if (!result.sources.length) return result;

  // Codec-first order for which candidates to probe (name bonus still OK as selection hint).
  const candidates = [...result.sources]
    .sort((a, b) => {
      const aHevc = isHevcStream(a.url) ? 1 : 0;
      const bHevc = isHevcStream(b.url) ? 1 : 0;
      if (aHevc !== bHevc) return aHevc - bHevc;
      return entryScore(b) - entryScore(a);
    })
    .slice(0, 8);

  const started = Date.now();
  const qualityEntries: QualityProbeEntry[] = result.sources.map((entry) => ({
    url: entry.url,
    label: entry.label,
    quality: entry.quality,
    provider: entry.provider,
    session: entry.session,
    type: entry.type,
  }));
  const [probeMap, qualityMap] = await Promise.all([
    probeSourceBatch(candidates, { mediaType, expectedDurationS }),
    probeSourceQuality(qualityEntries, {
      preferredHeight: currentQualityHintHeight(),
    }),
  ]);
  let sources: SourceEntry[] = result.sources.map((entry) => {
    const probe = probeMap.get(entry.url);
    const q = qualityMap.get(entry.url);
    if (!q) {
      return { ...entry, ...(probe ? { probe } : {}) };
    }
    // Preserve URL-token height when manifest probe returns unknown (0).
    const priorH =
      entry.maxHeight != null && entry.maxHeight > 0
        ? entry.maxHeight
        : entry.ladder?.[0] != null && entry.ladder[0] > 0
          ? entry.ladder[0]
          : inferHeightFromUrl(`${entry.url} ${entry.label} ${entry.quality}`);
    const fromManifest = q.maxHeight > 0 && q.qualitySource === "manifest";
    const maxHeight = q.maxHeight > 0 ? q.maxHeight : priorH > 0 ? priorH : 0;
    const ladder = q.ladder.length
      ? q.ladder
      : entry.ladder && entry.ladder.length
        ? entry.ladder
        : undefined;
    // Prefer ladder[0] when present so maxHeight never lags behind known rungs.
    const ladderTop = ladder?.[0] != null && ladder[0] > 0 ? ladder[0] : 0;
    const resolvedHeight = Math.max(maxHeight, ladderTop);
    let qualitySource: QualitySource | undefined = q.qualitySource;
    if (resolvedHeight > 0 && q.maxHeight <= 0 && priorH > 0) {
      // Kept prior token/hint height after probe unknown.
      qualitySource = entry.qualitySource ?? "label";
    } else if (fromManifest) {
      qualitySource = "manifest";
    } else if (resolvedHeight <= 0) {
      qualitySource = "unknown";
    }
    return {
      ...entry,
      ...(probe ? { probe } : {}),
      type: q.type,
      maxHeight: resolvedHeight,
      ...(ladder?.length ? { ladder } : {}),
      ...(qualitySource ? { qualitySource } : {}),
      ...(q.bitrateBps != null && q.bitrateBps > 0
        ? { bitrateBps: q.bitrateBps }
        : {}),
    };
  });

  const truncatedUrls = new Set(
    [...probeMap.entries()]
      .filter(([, probe]) => probe.error === "implausibly_short_duration")
      .map(([url]) => url)
  );
  if (truncatedUrls.size > 0) {
    sources = sources.filter((entry) => !truncatedUrls.has(entry.url));
    logAt(
      "warn",
      `[duration] rejected ${truncatedUrls.size} truncated source(s) (expected ${Math.round(expectedDurationS)}s)`
    );
  }
  if (!sources.length) {
    return {
      streamUrl: null,
      sources: [],
      error: "Only truncated preview streams were returned.",
    };
  }

  // LordFlix-style roster: keep probe-failed + unprobed for manual server switching.
  // Default pick still ranks probe.ok first via sortSourcesForDefault.
  const failedCount = sources.filter((s) => s.probe?.ok === false).length;
  if (failedCount > 0) {
    logAt(
      "info",
      `[probe] keeping ${failedCount} failed source(s) in roster for manual switch (not auto-default)`
    );
  }

  const sorted = sortSourcesForDefault(filterHighQualitySources(sources));
  const okCount = sorted.filter((s) => s.probe?.ok).length;
  const defaultUrl = pickDefaultStreamUrl(sorted);
  const defaultEntry = sorted.find((s) => s.url === defaultUrl) ?? sorted[0];
  logAt(
    "info",
    `[probe] ${probeMap.size} measured, ${okCount} ok, ${failedCount} failed, ${sorted.length} total in ${Date.now() - started}ms — default: ${defaultEntry?.label ?? "?"} (${defaultEntry?.probe?.speedScore ?? "n/a"})`
  );
  const knownQuality = sorted.filter((s) => (s.maxHeight ?? 0) > 0).length;
  const bestHeight = sorted.reduce((max, s) => Math.max(max, s.maxHeight ?? 0), 0);
  logAt(
    "info",
    `[quality] ${qualityMap.size} classified, ${knownQuality} with known resolution, best ${bestHeight || "?"}p`
  );

  return {
    ...result,
    sources: sorted,
    streamUrl: defaultUrl ?? result.streamUrl,
  };
}

const CDN_HOSTS = [
  "infantinostreet.site",
  "ironbubble.site",
  "moon.ironbubble.site",
  "ironwallnet.net",
  "moon.ironwallnet.net",
  "hakunaymatata.com",
];

function isSegmentUrl(url: string): boolean {
  if (!CDN_HOSTS.some((h) => url.includes(h))) return false;
  return !url.includes(".m3u8");
}

function pickExtraHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = ["referer", "origin", "user-agent", "accept", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"];
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (allow.includes(key) && v) out[key] = v;
  }
  return out;
}

function scoreCapture(url: string, label: string): number {
  // H264/HLS preferred over HEVC for broad device support + buffer stability.
  if ((url.includes(".m3u8") || label === "HLS") && !isHevcStream(url)) return 100;
  if (url.includes(".m3u8") || label === "HLS") return 40;
  if (url.includes(".mpd") || label === "DASH") {
    if (isHevcStream(url)) return 15;
    return 70;
  }
  if (isHevcStream(url)) return 10;
  // Progressive MP4: optional small penalty vs adaptive HLS for long titles.
  if (url.includes(".mp4")) return 60;
  return 40;
}

function isHevcStream(url: string): boolean {
  return url.includes("h265") || url.includes("hevc") || url.includes("hev1");
}

const CDN_REFERERS: Record<string, string> = {
  "moon.ironbubble.site": "https://www.vidking.net/",
  "infantinostreet.site": "https://www.vidking.net/",
  "ironbubble.site": "https://www.vidking.net/",
  // Vidking 4K / multi-rung CDN (probe 403 without this referer)
  "moon.ironwallnet.net": "https://www.vidking.net/",
  "ironwallnet.net": "https://www.vidking.net/",
  "storm.vodvidl.site": "https://vidlink.pro/",
  "sacdn.hakunaymatata.com": "https://vidlink.pro/",
  "bcdn.hakunaymatata.com": "https://vidlink.pro/",
};

function refererForCdn(targetUrl: string, referer: string): string {
  try {
    const host = new URL(targetUrl).hostname;
    return CDN_REFERERS[host] || referer;
  } catch {
    return referer;
  }
}

/**
 * What an HLS verification learned about the stream.
 *
 * `maxHeight`/`ladder` come from the master playlist's own `RESOLUTION=`
 * attributes, which this walk already downloads and parses in order to CHOOSE a
 * variant — it just used to throw the numbers away and answer a bare boolean.
 * That is why most NoTorrent/Pulse rows reached the picker with no resolution
 * at all: measured on Breaking Bad S1E1, 8 of 11 sources reported height 0, so
 * the Servers list could not label them and ranking could not tell a 1080p
 * source from a 480p one. Reading them out costs no extra request.
 */
export interface HlsVerifyResult {
  ok: boolean;
  /** Highest RESOLUTION height advertised by the master, 0 if none was seen. */
  maxHeight: number;
  /** Every advertised height, descending — a real adaptive ladder. */
  ladder: number[];
}

async function verifyHlsServer(
  manifestUrl: string,
  referer: string,
  userAgent: string,
  cookies: string
): Promise<HlsVerifyResult> {
  try {
    const effectiveReferer = refererForCdn(manifestUrl, referer);
    let origin = effectiveReferer;
    try {
      origin = new URL(effectiveReferer).origin;
    } catch {
      /* keep referer */
    }
    const headers: Record<string, string> = {
      Referer: effectiveReferer,
      Origin: origin,
      "User-Agent": userAgent,
      Accept: "*/*",
    };
    if (cookies) headers.Cookie = cookies;

    // Heights seen on any master along the walk. Collected on the way past;
    // the variant CHOICE below deliberately avoids the top rungs (they often
    // 403 on VidApi), but what the master ADVERTISES is still the truth about
    // what the source offers, so the two must not be conflated.
    const seenHeights = new Set<number>();
    const fail = (): HlsVerifyResult => ({ ok: false, maxHeight: 0, ladder: [] });
    const done = (ok: boolean): HlsVerifyResult => {
      const ladder = [...seenHeights].sort((a, b) => b - a);
      return { ok, maxHeight: ladder[0] ?? 0, ladder };
    };

    // Walk master → nested master → media, then require a real segment body.
    // Never treat "playlist has #EXTINF" alone as success (Horizon 2–4: media 200, seg 403).
    let url = manifestUrl;
    let text = "";
    for (let hop = 0; hop < 4; hop++) {
      const res = await curlGet(url, { headers, timeoutSec: 20 });
      if (!res.ok || !res.text.includes("#EXTM3U")) return fail();
      text = res.text;
      const lines = text.split("\n").map((l) => l.trim());
      const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
      if (isMaster) {
        let next: string | null = null;
        let bestBw = Number.POSITIVE_INFINITY;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.startsWith("#EXT-X-STREAM-INF")) continue;
          const n = lines[i + 1];
          if (!n || n.startsWith("#")) continue;
          const bw = Number(lines[i]!.match(/BANDWIDTH=(\d+)/i)?.[1] || 0);
          const h = Number(lines[i]!.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0);
          if (h > 0) seenHeights.add(h);
          // Prefer ≤720p mid bitrate (top rungs often 403 on VidApi).
          if (h > 720 && h > 0) continue;
          const score = Math.abs((bw || 2_500_000) - 2_500_000);
          if (score < bestBw) {
            bestBw = score;
            next = n.startsWith("http") ? n : new URL(n, url).toString();
          }
        }
        if (!next) {
          // fallback any variant
          const any = lines.find((l, i) => {
            if (!lines[i - 1]?.startsWith("#EXT-X-STREAM-INF")) return false;
            return !!l && !l.startsWith("#");
          });
          if (!any) return done(false);
          next = any.startsWith("http") ? any : new URL(any, url).toString();
        }
        url = next;
        continue;
      }
      // Media playlist — fetch first segment
      const segLine = lines.find((l) => l && !l.startsWith("#"));
      if (!segLine) return done(false);
      const segUrl = segLine.startsWith("http") ? segLine : new URL(segLine, url).toString();
      const segRes = await curlGet(segUrl, { headers, timeoutSec: 20 });
      if (!segRes.ok || segRes.body.byteLength < 500) return done(false);
      const head = segRes.text?.trimStart().slice(0, 16) || "";
      // Nested playlist mistaken as segment
      if (head.startsWith("#EXTM3U")) {
        url = segUrl;
        continue;
      }
      // Icefy/Aether ad tiles (PNG/JPEG) — not playable video
      const body = segRes.text || "";
      if (
        body.startsWith("\u0089PNG") ||
        body.includes("IHDR") ||
        body.startsWith("GIF8") ||
        body.startsWith("\u00ff\u00d8\u00ff")
      ) {
        return done(false);
      }
      return done(true);
    }
    return done(false);
  } catch {
    return { ok: false, maxHeight: 0, ladder: [] };
  }
}

async function pickAllVerifiedCaptures(
  captures: StreamCapture[],
  embedUrl: string,
  cookies: string
): Promise<StreamCapture[]> {
  // Quality-aware order: masters / highest height before score-only.
  const ordered = selectEmbedCaptures(captures, captures.length);
  const referer = embedUrl.includes("vidking.net") ? embedUrl : ordered[0]?.referer || embedUrl;
  const verified: StreamCapture[] = [];
  let hevcFallback: StreamCapture | null = null;

  for (const capture of ordered) {
    if (verified.length >= MAX_CAPTURES_PER_EMBED) break;

    // Prefer H264; park one HEVC as last-resort instead of hard-dropping.
    if (isHevcStream(capture.url)) {
      if (!hevcFallback) hevcFallback = capture;
      if (verified.some((v) => !isHevcStream(v.url))) continue;
    }

    if (capture.url.includes(".m3u8")) {
      const { ok } = await verifyHlsServer(
        capture.url,
        embedUrl.includes("vidking.net") ? embedUrl : capture.referer || referer,
        capture.userAgent,
        cookies
      );
      if (ok) verified.push(capture);
      continue;
    }
    if (capture.url.includes(".mpd")) {
      try {
        const mpdRes = await curlGet(capture.url, {
          headers: {
            Referer: refererForCdn(capture.url, capture.referer || referer),
            Origin: capture.origin || referer,
            "User-Agent": capture.userAgent,
          },
          timeoutSec: VERIFY_TIMEOUT_SEC,
        });
        if (mpdRes.ok && mpdRes.text.includes("<MPD")) {
          if (isHevcStream(capture.url)) {
            if (!hevcFallback) hevcFallback = capture;
          } else {
            verified.push(capture);
          }
        }
      } catch {
        /* try next */
      }
      continue;
    }
    // MP4 / direct
    if (isHevcStream(capture.url)) {
      if (!hevcFallback) hevcFallback = capture;
      continue;
    }
    verified.push(capture);
  }

  // Last-resort: keep one HEVC when no non-HEVC verified (stormvv / h265 MP4).
  if (!verified.length && hevcFallback) {
    const cap = hevcFallback;
    if (cap.url.includes(".m3u8")) {
      const { ok } = await verifyHlsServer(
        cap.url,
        embedUrl.includes("vidking.net") ? embedUrl : cap.referer || referer,
        cap.userAgent,
        cookies
      );
      if (ok) verified.push(cap);
    } else if (cap.url.includes(".mpd")) {
      try {
        const mpdRes = await curlGet(cap.url, {
          headers: {
            Referer: refererForCdn(cap.url, cap.referer || referer),
            Origin: cap.origin || referer,
            "User-Agent": cap.userAgent,
          },
          timeoutSec: VERIFY_TIMEOUT_SEC,
        });
        if (mpdRes.ok && mpdRes.text.includes("<MPD")) verified.push(cap);
      } catch {
        /* ignore */
      }
    } else {
      verified.push(cap);
    }
  }

  // Re-order verified by multi-capture preference (master / height).
  return selectEmbedCaptures(verified, MAX_CAPTURES_PER_EMBED);
}

/**
 * PNG / JPEG / GIF / WEBP magic bytes.
 *
 * Several embed CDNs answer a media request with an ad tile rather than an
 * error, so "the server returned bytes" is not evidence of a live source.
 * `verifyHlsServer` already rejects these on the segment it walks to; this is
 * the byte-level equivalent for the progressive path.
 *
 * Note the GIF check deliberately compares all four bytes: 0x47 alone is also
 * the MPEG-TS sync byte, so a shorter check would discard real TS segments.
 */
function isImagePayload(body: Buffer): boolean {
  if (body.byteLength < 4) return false;
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return true;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true;
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x38) return true;
  if (
    body.byteLength >= 12 &&
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) {
    return true;
  }
  return false;
}

/** Probe API-sourced entries so dead CDN URLs never fill a server slot. */
async function verifySourceEntry(entry: SourceEntry): Promise<HlsVerifyResult> {
  const referer = entry.session.referer || "";
  const origin = entry.session.origin || referer;
  const ua = entry.session.userAgent || DEFAULT_UA;
  const cookies = entry.session.cookies || "";
  const lower = entry.url.toLowerCase();

  try {
    // Any real m3u8 — full HLS hop (a master can 200 while its segments 403).
    //
    // `/v1/proxy` and `cinepro` URLs are deliberately NOT forced down this path
    // any more. CinePro's proxy wraps BOTH HLS masters (VixSrc, Icefy) AND
    // progressive MP4 rungs (FshareTV), and `verifyHlsServer` hard-requires
    // `#EXTM3U`, so every MP4 rung failed verification for the sole reason that
    // it was not HLS. They were then soft-kept (`verified: false`), which makes
    // them permanently ineligible for auto-default — while measuring 6/6
    // playable through the real `/api/hls` path in production. Sniffing the
    // body below routes on what the URL actually IS: an m3u8 body still gets
    // the full walk (so Icefy's ad-image segments are still caught), and a real
    // media body is accepted on its own terms.
    if (lower.includes(".m3u8") || lower.includes("/playlist/")) {
      return verifyHlsServer(entry.url, referer, ua, cookies);
    }
    // Only HLS masters advertise RESOLUTION; the other branches answer with
    // ok/not-ok and no height, exactly as before.
    const plain = (ok: boolean): HlsVerifyResult => ({ ok, maxHeight: 0, ladder: [] });
    if (entry.url.includes(".mpd")) {
      const mpdRes = await curlGet(entry.url, {
        headers: {
          Referer: refererForCdn(entry.url, referer),
          Origin: origin,
          "User-Agent": ua,
        },
        timeoutSec: VERIFY_TIMEOUT_SEC,
      });
      return plain(mpdRes.ok && mpdRes.text.includes("<MPD"));
    }
    // Sniff: an m3u8 without the extension, or a real progressive media body.
    const headers: Record<string, string> = {
      Referer: refererForCdn(entry.url, referer),
      Origin: origin,
      "User-Agent": ua,
      Range: "bytes=0-4095",
      Accept: "*/*",
    };
    if (cookies) headers.Cookie = cookies;
    const res = await curlGet(entry.url, { headers, timeoutSec: VERIFY_TIMEOUT_SEC });
    if (!res.ok || res.body.byteLength < 200) return plain(false);
    const head = res.text?.trimStart() || "";
    if (head.startsWith("#EXTM3U")) {
      return verifyHlsServer(entry.url, referer, ua, cookies);
    }
    // Now that progressive bodies reach this branch (see the routing note
    // above), "returned some bytes" is too weak on its own: several embed CDNs
    // answer with an ad tile instead of media. Reject the image signatures the
    // HLS walk already rejects, so both paths apply the same standard.
    if (isImagePayload(res.body)) return plain(false);
    return plain(res.body.byteLength > 200);
  } catch {
    return { ok: false, maxHeight: 0, ladder: [] };
  }
}

/**
 * Fold what verification learned about resolution into the entry.
 *
 * Only fills gaps: a real quality probe (`quality-probe.ts`) measures the
 * stream itself and is authoritative, so an entry that already has a height
 * keeps it. This exists for the entries that had none — the master's own
 * RESOLUTION attributes are the only resolution evidence those sources ever
 * offer, and without them the Servers list shows a bare name and ranking
 * cannot tell 1080p from 480p.
 */
function withVerifiedHeight(entry: SourceEntry, result: HlsVerifyResult): SourceEntry {
  if (!result.maxHeight) return entry;
  if ((entry.maxHeight ?? 0) > 0) return entry;
  return {
    ...entry,
    maxHeight: result.maxHeight,
    // A single advertised rendition is not a ladder; leave those alone so
    // `isMultiRendition` keeps meaning what it says.
    ladder: result.ladder.length > 1 ? result.ladder : entry.ladder,
    quality: entry.quality === "auto" ? `${result.maxHeight}p` : entry.quality,
  };
}

/** Soft-kept roster cap (unverified rows kept for manual server switching). */
const SOFT_KEEP_MAX = 12;

/**
 * Passing probes → verified:true.
 * softKeep: also keep failing candidates as verified:false so multi-server
 * rosters (CinePro multi-quality, etc.) are not wiped when only 1 CDN verifies.
 * Auto-default never prefers verified:false when any verified:true exists.
 */
async function filterVerifiedEntries(
  entries: SourceEntry[],
  options: { softKeep?: boolean } = {}
): Promise<SourceEntry[]> {
  if (!entries.length) return [];
  const softKeep = options.softKeep !== false;
  const ranked = [...entries].sort((a, b) => entryScore(b) - entryScore(a));
  const results = await Promise.all(
    ranked.map(async (entry) => {
      const result = await verifySourceEntry(entry);
      return { entry: withVerifiedHeight(entry, result), ok: result.ok };
    })
  );
  const good = results
    .filter((r) => r.ok)
    .map((r) => ({ ...r.entry, verified: true as const }));
  if (!softKeep) {
    if (!good.length) {
      logAt("warn", `[verify] all ${entries.length} failed — keeping none`);
    }
    return good;
  }
  const soft = results
    .filter((r) => !r.ok)
    .map((r) => ({ ...r.entry, verified: false as const }))
    .slice(0, SOFT_KEEP_MAX);
  if (soft.length) {
    logAt(
      "info",
      `[verify] ${good.length} ok + soft-keeping ${soft.length}/${entries.length - good.length} failed for roster`
    );
  }
  if (!good.length && !soft.length) return [];
  return [...good, ...soft];
}


function isValidStreamUrl(url: string): boolean {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
  if (isPreviewOrSampleUrl(url)) return false;
  // CinePro/OMSS proxy URLs rarely contain .m3u8 in the outer path.
  if (url.includes("/v1/proxy") || url.toLowerCase().includes("cinepro")) return true;
  return (
    url.includes(".m3u8") ||
    url.includes(".mp4") ||
    url.includes(".mpd") ||
    url.includes(".m4s") ||
    url.includes("ironbubble") ||
    url.includes("/playlist/") ||
    url.includes("vid1.php")
  );
}

interface ScraperPool {
  /** Idle browsers ready to check out. */
  browsers: Browser[];
  queue: ((b: Browser) => void)[];
  warming: boolean;
  /** Idle + checked-out. Never launch when live >= MAX_BROWSERS. */
  live: number;
}

const pool: ScraperPool = { browsers: [], queue: [], warming: false, live: 0 };

async function warmBrowsers(): Promise<void> {
  if (pool.warming) return;
  if (pool.live >= MAX_BROWSERS) return;
  pool.warming = true;
  try {
    while (pool.live < MAX_BROWSERS) {
      pool.live += 1;
      try {
        const browser = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--mute-audio",
          ],
        });
        pool.browsers.push(browser);
        console.log(`[pool] warmed browser ${pool.live}/${MAX_BROWSERS}`);
      } catch (e) {
        pool.live = Math.max(0, pool.live - 1);
        console.error("[pool] failed to warm:", e);
        break;
      }
    }
  } finally {
    pool.warming = false;
  }
  while (pool.queue.length > 0 && pool.browsers.length > 0) {
    const cb = pool.queue.shift()!;
    cb(pool.browsers.shift()!);
  }
}

function dropIdleBrowser(browser: Browser): void {
  browser.close().catch(() => {});
  pool.live = Math.max(0, pool.live - 1);
}

async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let run: (b: Browser) => void;

    const recycleBrowser = (b: Browser): void => {
      // Return to idle only when under hard cap (guards historical over-spawn).
      if (pool.browsers.length < MAX_BROWSERS && pool.live <= MAX_BROWSERS) {
        pool.browsers.push(b);
      } else {
        dropIdleBrowser(b);
      }
      while (pool.queue.length > 0 && pool.browsers.length > 0) {
        pool.queue.shift()!(pool.browsers.shift()!);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Drop this waiter from the queue — previously left zombies that ate the pool.
      const idx = pool.queue.indexOf(run);
      if (idx >= 0) pool.queue.splice(idx, 1);
      reject(new Error("Scraper is busy — try again in a moment."));
    }, POOL_WAIT_TIMEOUT);

    run = (b: Browser) => {
      if (settled) {
        // Timed-out waiter was still dequeued — hand browser to next real job.
        recycleBrowser(b);
        return;
      }
      clearTimeout(timeout);
      fn(b)
        .then((r) => {
          recycleBrowser(b);
          if (!settled) {
            settled = true;
            resolve(r);
          }
        })
        .catch((e) => {
          b.close().catch(() => {});
          pool.live = Math.max(0, pool.live - 1);
          warmBrowsers();
          if (!settled) {
            settled = true;
            reject(e);
          }
        });
    };
    while (pool.browsers.length > 0 && !pool.browsers[0]!.isConnected()) {
      const dead = pool.browsers.shift()!;
      dead.close().catch(() => {});
      pool.live = Math.max(0, pool.live - 1);
      warmBrowsers();
    }
    if (pool.browsers.length > 0) run(pool.browsers.shift()!);
    else {
      pool.queue.push(run);
      warmBrowsers();
    }
  });
}

interface CacheEntry {
  result: ScrapeResult;
  expiresAt: number;
}
const MAX_RESULT_CACHE = 200;
const resultCache = new Map<string, CacheEntry>();
const resultCacheOrder: string[] = [];

function removeFromResultCacheOrder(key: string): void {
  const idx = resultCacheOrder.indexOf(key);
  if (idx >= 0) resultCacheOrder.splice(idx, 1);
}

function cacheTtlForResult(result: ScrapeResult): number {
  const preferred = currentQualityHintHeight();
  const url = result.streamUrl ?? "";
  const base = url ? cacheTtlFor(url) : CACHE_TTL_MS;
  if (preferred > 1080 && !rosterHasPlayableHeight(result.sources, preferred)) {
    return Math.min(Math.max(base, 1_000), ULTRA_MISS_TTL_MS);
  }
  if (rosterHasPlayableHeight(result.sources, 2160)) {
    return Math.max(base, FOUR_K_ROSTER_TTL_MS);
  }
  return base;
}

function setCachedResult(key: string, result: ScrapeResult): void {
  const ttl = cacheTtlForResult(result);
  if (ttl <= 0) return;

  if (resultCache.has(key)) removeFromResultCacheOrder(key);
  resultCache.set(key, { result, expiresAt: Date.now() + ttl });
  resultCacheOrder.push(key);
  while (resultCacheOrder.length > MAX_RESULT_CACHE) {
    const oldest = resultCacheOrder.shift();
    if (oldest) resultCache.delete(oldest);
  }
}

function getCached(key: string): ScrapeResult | null {
  const entry = resultCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) {
      resultCache.delete(key);
      removeFromResultCacheOrder(key);
    }
    return null;
  }
  return entry.result;
}

/**
 * Extra grace window when the only .m3u8 captured so far is a media (not master) playlist.
 * Phase 3 intercept: 5000 → 2500 (early-exit already settles ~1.5s after first good).
 */
const MASTER_WAIT_GRACE_MS = 2500;
/**
 * After first stream URL lands, brief window for sibling variant/master m3u8 XHRs
 * without extending the overall Playwright budget (smarter wait, not longer).
 */
const EXTRA_M3U8_GRACE_MS = 1800;
/** Click-retry after empty capture poll — short fixed window. */
const CLICK_RETRY_WAIT_MS = 1_800;
/** How often to re-scan video/src during the capture poll loop. */
const VIDEO_SOURCE_CHECK_INTERVAL_MS = 1_000;

/**
 * Per-peek network budget.
 *
 * Was 6s, and up to three candidates were peeked in sequence — so a capture that
 * had ALREADY succeeded could still spend 18s here and blow the whole per-embed
 * worker budget. That is exactly what was happening to Vidking: standalone it
 * intercepts a stream 7.1–8.3s after goto, but every production attempt died at
 * the 14s worker wall with "timed out" and contributed 0 sources, while also
 * eating so much of the shared PW wall that the secondary wave never started
 * ("PW secondary skipped, remaining 5989ms < 6000ms").
 *
 * This peek only marks `isMaster` to ORDER captures in `selectEmbedCaptures`.
 * It is not correctness-critical: the real rendition ladder is measured later by
 * quality-probe.ts, and `looksLikeHlsMasterUrl` already gives a usable heuristic
 * for free. Losing an ordering hint is a far cheaper failure than losing the
 * entire embed.
 */
const MASTER_PEEK_TIMEOUT_SEC = 2;
/** At most one peek per embed — see MASTER_PEEK_TIMEOUT_SEC for why. */
const MASTER_PEEK_MAX_CANDIDATES = 1;

/**
 * Peek the body of a captured .m3u8 without a network fetch on the hot path —
 * bounded, best-effort. False (no master seen yet) on any failure so the
 * caller just falls through to its existing capture set instead of stalling.
 */
const MASTER_RECONSTRUCT_MAX = 2;

async function injectReconstructedMasters(
  captures: StreamCapture[],
  referer: string
): Promise<void> {
  if (captures.some((cap) => cap.isMaster || looksLikeHlsMasterUrl(cap.url))) {
    return;
  }
  const seen = new Set(captures.map((cap) => normalizeStreamUrl(cap.url)));
  const guesses: StreamCapture[] = [];
  for (const cap of captures) {
    if (!cap.url.includes(".m3u8")) continue;
    for (const master of candidateMasterUrls(cap.url)) {
      const key = normalizeStreamUrl(master);
      if (seen.has(key)) continue;
      seen.add(key);
      guesses.push({
        ...cap,
        url: master,
        isMaster: true,
        score: cap.score + 80,
        label: cap.label || "HLS",
      });
    }
  }
  for (const guess of guesses.slice(0, MASTER_RECONSTRUCT_MAX)) {
    if (await hasMasterPlaylist(guess, referer)) {
      captures.push(guess);
      logAt("info", `[scrape] reconstructed adaptive master from quality child`);
    }
  }
}

async function hasMasterPlaylist(capture: StreamCapture, referer: string): Promise<boolean> {
  try {
    const effectiveReferer = refererForCdn(capture.url, capture.referer || referer);
    const res = await curlGet(capture.url, {
      headers: {
        Referer: effectiveReferer,
        "User-Agent": capture.userAgent || DEFAULT_UA,
        Accept: "*/*",
      },
      timeoutSec: MASTER_PEEK_TIMEOUT_SEC,
    });
    return res.ok && isHlsMasterManifest(res.text);
  } catch {
    return false;
  }
}

async function tryScrapeUrl(
  embedUrl: string,
  waitUntil: "domcontentloaded" | "networkidle",
  options: {
    skipVerify?: boolean;
    gotoTimeoutMs?: number;
    captureWaitMs?: number;
    /** Shared cancel flag — set by per-embed / global worker budget timeout. */
    cancelled?: { cancelled: boolean };
  } = {}
): Promise<ScrapeResult> {
  return withBrowser(async (browser) => {
    const isCancelled = (): boolean => options.cancelled?.cancelled === true;
    const cancelledResult = (): ScrapeResult => ({
      streamUrl: null,
      sources: [],
      error: "cancelled",
    });

    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });

    // Strip the automation tell so basic bot checks (navigator.webdriver) don't
    // gate playback before a single stream request fires.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await context.route("**/*", (route) => {
      if (isCancelled()) {
        route.abort().catch(() => {});
        return;
      }
      const url = route.request().url();
      const type = route.request().resourceType();
      const blocked = [
        "doubleclick.net",
        "googlesyndication.com",
        "googletagmanager.com",
        "google-analytics.com",
        "popads",
        "adsterra",
      ];
      if (blocked.some((d) => url.includes(d))) {
        route.abort().catch(() => {});
        return;
      }
      if (type === "font") {
        route.abort().catch(() => {});
        return;
      }
      route.continue().catch(() => {});
    });

    const page = await context.newPage();
    const captures: StreamCapture[] = [];
    let segmentHeaders: Record<string, string> = {};
    /** Wall-clock of first good (non-poison HLS/MP4) capture for early-exit settle. */
    let firstGoodAtMs: number | null = null;

    const recordCapture = (url: string, label: string, referer: string, userAgent: string) => {
      if (isCancelled()) return;
      if (!isValidStreamUrl(url)) return;
      const norm = normalizeStreamUrl(url);
      const existingIdx = captures.findIndex((c) => normalizeStreamUrl(c.url) === norm);
      if (existingIdx >= 0) {
        // Keep first path identity; prefer higher score / preserve isMaster.
        const prev = captures[existingIdx]!;
        const nextScore = scoreCapture(url, label);
        if (nextScore > prev.score) {
          captures[existingIdx] = { ...prev, url, score: nextScore, label: prev.label || label };
        }
        return;
      }
      let origin = "";
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = referer;
      }
      captures.push({
        url,
        quality: "auto",
        label,
        referer,
        origin,
        userAgent: userAgent || DEFAULT_UA,
        score: scoreCapture(url, label),
      });
      if (firstGoodAtMs == null && isGoodEarlyCapture(url, label)) {
        firstGoodAtMs = Date.now();
      }
      logAt("info", `[scrape] found ${label}: ${url.slice(0, 90)}`);
    };

    context.on("request", (req) => {
      if (isCancelled()) return;
      const u = req.url();
      let frameUrl = embedUrl;
      try {
        frameUrl = req.frame()?.url() || embedUrl;
      } catch {
        frameUrl = embedUrl;
      }
      const rawHeaders = req.headers();
      const ua = rawHeaders["user-agent"] || DEFAULT_UA;
      if (isSegmentUrl(u)) {
        segmentHeaders = pickExtraHeaders(rawHeaders);
      }
      if (u.includes(".m3u8")) recordCapture(u, "HLS", frameUrl, ua);
      else if (u.includes(".mpd")) recordCapture(u, "DASH", frameUrl, ua);
      else if (u.includes(".mp4")) recordCapture(u, "MP4", frameUrl, ua);
      else if (u.includes(".m4s")) recordCapture(u, "MP4", frameUrl, ua);
    });

    page.on("response", (res) => {
      if (isCancelled()) return;
      const u = res.url();
      const debugOn = isDebugEnabled();
      const headers = debugOn || !hasStreamExtension(u) ? res.headers() : null;

      if (debugOn) {
        const cl = headers ? Number(headers["content-length"] || "") : NaN;
        recordDebugCapture({
          url: u,
          status: res.status(),
          contentType: headers?.["content-type"] || "",
          size: Number.isFinite(cl) ? cl : null,
          provider: providerFromEmbed(embedUrl),
        });
      }

      if (u.includes(".m3u8")) {
        recordCapture(u, "HLS", embedUrl, DEFAULT_UA);
        return;
      }
      if (u.includes(".mpd")) {
        recordCapture(u, "DASH", embedUrl, DEFAULT_UA);
        return;
      }
      if (u.includes(".mp4") && !u.includes(".srt")) {
        recordCapture(u, "MP4", embedUrl, DEFAULT_UA);
        return;
      }
      if (u.includes(".m4s")) {
        recordCapture(u, "MP4", embedUrl, DEFAULT_UA);
        return;
      }
      // Extension-less CDN paths — sniff Content-Type/-Length instead of trusting the URL.
      if (headers) {
        const contentType = headers["content-type"] || "";
        if (isLikelyVideoMime(contentType)) {
          const cl = Number(headers["content-length"] || "");
          if (isCaptureWorthySize(Number.isFinite(cl) ? cl : null)) {
            recordCapture(u, labelFromMime(contentType), embedUrl, DEFAULT_UA);
          }
        }
      }
    });

    const checkVideoSources = async () => {
      if (isCancelled()) return;
      for (const frame of page.frames()) {
        if (isCancelled()) return;
        try {
          const src = await frame
            .evaluate(() => {
              const video = document.querySelector("video");
              if (!video) return null;
              return video.getAttribute("src") || video.querySelector("source")?.getAttribute("src") || null;
            })
            .catch(() => null);
          if (src) recordCapture(src, "Direct", frame.url() || embedUrl, DEFAULT_UA);
        } catch {
          /* ignore */
        }
      }
    };

    try {
      if (isCancelled()) {
        await context.close();
        return cancelledResult();
      }

      const gotoTimeout = options.gotoTimeoutMs ?? PAGE_TIMEOUT;
      await page.goto(embedUrl, { waitUntil, timeout: gotoTimeout });

      if (isCancelled()) {
        await context.close();
        return cancelledResult();
      }

      // Network-intercept early-exit: poll instead of fixed captureWaitMs race.
      const captureWait = options.captureWaitMs ?? 12_000;
      const waitStarted = Date.now();
      const hardDeadline = waitStarted + captureWait;
      let lastVideoCheckAt = 0;
      let earlyExited = false;

      while (Date.now() < hardDeadline && !isCancelled()) {
        if (
          shouldEarlyExitWait({
            captures,
            firstGoodAtMs,
            nowMs: Date.now(),
            hardDeadlineMs: hardDeadline,
          })
        ) {
          // Only log when we left early with real captures (not hard-deadline win).
          if (Date.now() < hardDeadline && countGoodEarlyCaptures(captures) > 0) {
            earlyExited = true;
          }
          break;
        }
        const now = Date.now();
        if (now - lastVideoCheckAt >= VIDEO_SOURCE_CHECK_INTERVAL_MS) {
          lastVideoCheckAt = now;
          await checkVideoSources();
        }
        await page.waitForTimeout(EARLY_EXIT_POLL_MS);
      }

      if (earlyExited) {
        const ms = Date.now() - waitStarted;
        logAt(
          "info",
          `[scrape] early-exit after ${ms}ms captures=${captures.length} embed=${providerFromEmbed(embedUrl)}`
        );
      }

      if (isCancelled()) {
        await context.close();
        return cancelledResult();
      }

      await checkVideoSources();

      // Click retry only when still empty after the poll loop.
      if (captures.length === 0 && !isCancelled()) {
        for (const frame of page.frames()) {
          if (isCancelled()) break;
          try {
            await frame
              .click("button, [class*='play'], .play-btn", { timeout: 800 })
              .catch(() => {});
          } catch {
            /* ignore */
          }
        }
        if (!isCancelled()) {
          await page.waitForTimeout(CLICK_RETRY_WAIT_MS);
          await checkVideoSources();
        }
      }

      if (isCancelled()) {
        await context.close();
        return cancelledResult();
      }

      // Multi-URL quality capture:
      // - Master already present (URL heuristic / flag) → skip EXTRA + MASTER graces.
      // - Else short EXTRA_M3U8_GRACE, peek masters; remaining MASTER grace only when
      //   still thin on good captures (target not met).
      if (!isCancelled() && captures.some((c) => c.url.includes(".m3u8"))) {
        const hasMasterish = captures.some(
          (c) => c.isMaster || looksLikeHlsMasterUrl(c.url)
        );
        if (!hasMasterish) {
          await page.waitForTimeout(EXTRA_M3U8_GRACE_MS);
          await checkVideoSources();
        }

        if (!isCancelled()) {
          const hlsCaptures = captures.filter((c) => c.url.includes(".m3u8"));
          // Peek top candidates; mark any multi-rendition masters for selection.
          const peekOrder = selectEmbedCaptures(
            hlsCaptures,
            Math.min(MASTER_PEEK_MAX_CANDIDATES, hlsCaptures.length)
          );
          let anyMaster = false;
          for (const cand of peekOrder) {
            if (isCancelled()) break;
            const ok = await hasMasterPlaylist(cand, embedUrl);
            if (ok) {
              anyMaster = true;
              const idx = captures.findIndex(
                (c) => normalizeStreamUrl(c.url) === normalizeStreamUrl(cand.url)
              );
              if (idx >= 0) captures[idx] = { ...captures[idx]!, isMaster: true };
            }
          }
          // Skip remaining MASTER grace when master already known, or enough good captures.
          const goodEnough =
            anyMaster ||
            hasMasterish ||
            countGoodEarlyCaptures(captures) >= EARLY_EXIT_TARGET_CAPTURES;
          if (!goodEnough && !isCancelled()) {
            const remainingGrace = hasMasterish
              ? 0
              : Math.max(0, MASTER_WAIT_GRACE_MS - EXTRA_M3U8_GRACE_MS);
            if (remainingGrace > 0) {
              await page.waitForTimeout(remainingGrace);
              await checkVideoSources();
            }
            for (const cand of selectEmbedCaptures(
              captures.filter((c) => c.url.includes(".m3u8")),
              MASTER_PEEK_MAX_CANDIDATES
            )) {
              if (isCancelled()) break;
              if (cand.isMaster) continue;
              const ok = await hasMasterPlaylist(cand, embedUrl);
              if (ok) {
                const idx = captures.findIndex(
                  (c) => normalizeStreamUrl(c.url) === normalizeStreamUrl(cand.url)
                );
                if (idx >= 0) captures[idx] = { ...captures[idx]!, isMaster: true };
              }
            }
          }
        }
      }

      if (isCancelled()) {
        await context.close();
        return cancelledResult();
      }

      const storage = await context.storageState();
      const cookies = storage.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      if (captures.length === 0) {
        await context.close();
        return { streamUrl: null, sources: [], error: "No stream URL found." };
      }

      if (!isCancelled() && captures.some((c) => c.url.includes(".m3u8"))) {
        await injectReconstructedMasters(captures, embedUrl);
      }

      let verified: StreamCapture[];
      if (options.skipVerify) {
        // Multi-URL select: masters / highest height — not first-arriving only.
        const nonHevc = captures.filter((c) => !isHevcStream(c.url));
        verified = selectEmbedCaptures(
          nonHevc.length ? nonHevc : captures,
          MAX_CAPTURES_PER_EMBED
        );
      } else {
        verified = await pickAllVerifiedCaptures(captures, embedUrl, cookies);
      }

      await context.close();

      // Race timeout may have won while verify/goto finished — never ship late sources.
      if (isCancelled()) {
        return cancelledResult();
      }

      if (!verified.length) {
        const sorted = [...captures].sort((a, b) => b.score - a.score);
        const hlsFallback = sorted.find(
          (c) => c.url.includes(".m3u8") && !isHevcStream(c.url)
        );
        if (hlsFallback) {
          verified.push(hlsFallback);
        } else {
          const any = sorted.find((c) => !isHevcStream(c.url));
          if (any) verified.push(any);
          else if (sorted[0]) verified.push(sorted[0]);
        }
      }

      if (!verified.length) {
        return { streamUrl: null, sources: [], error: "Stream found but playback verification failed." };
      }

      if (isCancelled()) {
        return cancelledResult();
      }

      const provider = providerFromEmbed(embedUrl);
      const baseLabel = embedServerLabel(provider);
      const selected = selectEmbedCaptures(verified, MAX_CAPTURES_PER_EMBED);
      const sources: SourceEntry[] = selected.map((cap, index) => {
        const sessionReferer = embedUrl.includes("vidking.net") ? embedUrl : cap.referer || embedUrl;
        let sessionOrigin = cap.origin || embedUrl;
        try {
          sessionOrigin = new URL(sessionReferer).origin;
        } catch {
          /* keep */
        }
        const heightHint = inferHeightFromUrl(cap.url);
        return {
          url: cap.url,
          quality: heightHint > 0 ? `${heightHint}p` : "auto",
          label: embedCaptureLabel(baseLabel, index),
          provider,
          ...(heightHint > 0
            ? {
                maxHeight: heightHint,
                qualitySource: "label" as const,
                type: (cap.url.includes(".mpd")
                  ? "dash"
                  : cap.url.includes(".mp4")
                    ? "mp4"
                    : "hls") as SourceEntry["type"],
              }
            : {}),
          session: {
            referer: sessionReferer,
            origin: sessionOrigin,
            userAgent: cap.userAgent,
            cookies,
            extraHeaders: segmentHeaders,
          },
        };
      });

      if (isCancelled()) {
        return cancelledResult();
      }

      return {
        streamUrl: sources[0]!.url,
        sources,
      };
    } catch (e: unknown) {
      await context.close().catch(() => {});
      if (isCancelled()) return cancelledResult();
      const message = e instanceof Error ? e.message : String(e);
      return { streamUrl: null, sources: [], error: `Scrape failed: ${message}` };
    }
  });
}

function providerToEntry(stream: ProviderStream): SourceEntry {
  // Some providers already parse a real quality off their own manifest/API response
  // (e.g. Vixsrc's parseBestQuality, CinePro's upstream field) — keep it instead of
  // discarding it to "auto"; applyLatencyProbes still fills in maxHeight/ladder later.
  const q = (stream.quality || "").trim();
  const rungs = stream.qualityRungs?.filter((rung) => rung.height > 0 && rung.url);
  const ladder =
    stream.ladder && stream.ladder.length
      ? stream.ladder
      : rungs?.length
        ? rungs.map((rung) => rung.height)
        : undefined;
  const maxHeight =
    stream.maxHeight && stream.maxHeight > 0
      ? stream.maxHeight
      : ladder?.[0];
  return {
    url: stream.url,
    quality: q && q.toLowerCase() !== "auto" ? q : "auto",
    label: stream.label || stream.provider,
    provider: stream.provider,
    ...(stream.type ? { type: stream.type } : {}),
    ...(maxHeight ? { maxHeight, qualitySource: "label" as const } : {}),
    ...(ladder?.length ? { ladder } : {}),
    ...(rungs?.length ? { qualityRungs: rungs } : {}),
    ...(stream.audioLanguage ? { audioLanguage: stream.audioLanguage } : {}),
    session: {
      referer: stream.referer,
      origin: stream.origin,
      userAgent: stream.userAgent || DEFAULT_UA,
      cookies: "",
      extraHeaders: {},
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function resolveVixsrcFast(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  const result = await withCircuit(
    "vixsrc",
    async () => {
      const vixsrc = await withTimeout(
        resolveVixsrc(tmdbId, mediaType, season, episode),
        VIXSRC_TIMEOUT_MS
      );
      if (vixsrc == null) throw new Error("vixsrc_timeout");
      return vixsrc;
    },
    // Soft miss (0 streams for title) is not a provider outage
    { isSuccess: (streams) => streams != null }
  );
  if (!result) return [];
  return result.map(providerToEntry);
}

/**
 * VidLink API → up to MAX_VIDLINK_API_SOURCES entries with distinct labels.
 * Safe to call early in parallel with Luna (circuit-wrapped).
 */
async function resolveVidlinkEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  // Distinguish hard timeout from title miss (null). Old path treated both as
  // vidlink_timeout → circuit open → Phoenix gone for all TV.
  const vidlink = await withCircuit(
    "vidlink",
    async () => {
      let settled = false;
      const result = await Promise.race([
        resolveVidlinkApi(tmdbId, mediaType, season, episode).then((r) => {
          settled = true;
          return r;
        }),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), BACKGROUND_API_TIMEOUT_MS)
        ),
      ]);
      if (result === "timeout" && !settled) throw new Error("vidlink_timeout");
      return result === "timeout" ? null : result;
    },
    // Title miss (null / empty) is not an outage.
    { isSuccess: () => true }
  );
  if (!vidlink?.sources?.length) return [];

  const picked = pickVidlinkStreams(vidlink.sources);
  if (!picked.length) {
    logAt("info", `[vidlink-api] no usable streams after rank (had ${vidlink.sources.length})`);
    return [];
  }

  logAt(
    "info",
    `[vidlink-api] mapped ${picked.length} source(s) (from ${vidlink.sources.length} raw)`
  );

  return picked.map((stream, index) => {
    const rungs = stream.qualityRungs?.filter((rung) => rung.height > 0 && rung.url);
    const ladder = stream.ladder?.length
      ? stream.ladder
      : rungs?.map((rung) => rung.height);
    const maxHeight = stream.maxHeight || ladder?.[0];
    return {
      url: stream.url,
      quality: stream.quality || "auto",
      label: vidlinkSourceLabel(index),
      provider: "VidLink",
      ...(stream.type ? { type: stream.type } : {}),
      ...(maxHeight ? { maxHeight, qualitySource: "label" as const } : {}),
      ...(ladder?.length ? { ladder } : {}),
      ...(rungs?.length ? { qualityRungs: rungs } : {}),
      session: {
        referer: vidlink.session.referer,
        origin: vidlink.session.origin,
        userAgent: vidlink.session.userAgent,
        cookies: vidlink.session.cookies,
        extraHeaders: { ...vidlink.session.extraHeaders },
      },
    };
  });
}

/** NoTorrent only — used on the fast path so Pulse can race Luna without enc-dec noise. */
async function resolveNotorrentEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  const notorrent = await withCircuit(
    "notorrent",
    async () => {
      const r = await withTimeout(
        resolveNotorrent(tmdbId, mediaType, season, episode),
        BACKGROUND_API_TIMEOUT_MS
      );
      if (r == null) throw new Error("notorrent_timeout");
      return r;
    },
    { isSuccess: (r) => r != null }
  );
  if (!notorrent?.length) return [];
  const unverified = notorrent.map(providerToEntry);
  return filterVerifiedEntries(unverified);
}

/**
 * Background-enrich API pass: VidLink + NoTorrent only.
 * LordFlix/Videasy (enc-dec.app) were removed from the roster entirely
 * (2026-07-21 roster hygiene — 24h production logs showed 0/7 and 0/7
 * streams respectively, i.e. 100% zero-result). Do not re-add them here;
 * see docs/research/fmhy-15plus-source-map.md.
 */
async function resolveBackgroundApis(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: { skipVidlink?: boolean; skipNotorrent?: boolean } = {}
): Promise<SourceEntry[]> {
  const [vidlinkEntries, notorrentEntries] = await Promise.all([
    options.skipVidlink
      ? Promise.resolve([] as SourceEntry[])
      : resolveVidlinkEntries(tmdbId, mediaType, season, episode),
    options.skipNotorrent
      ? Promise.resolve([] as SourceEntry[])
      : resolveNotorrentEntries(tmdbId, mediaType, season, episode),
  ]);
  return [...vidlinkEntries, ...notorrentEntries];
}

/** CinePro (OMSS) — multi-provider + proxy; Lordflix-class fan-out when CINEPRO_URL set. */
async function resolveCineproEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: { timeoutMs?: number; mode?: "fast" | "full" } = {}
): Promise<SourceEntry[]> {
  if (!isCineproConfigured() || !isProviderEnabled("cinepro")) return [];
  const mode = options.mode === "fast" ? "fast" : "full";
  const timeoutMs =
    options.timeoutMs != null && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : mode === "fast"
        ? CINEPRO_FAST_TIMEOUT_MS
        : CINEPRO_FULL_TIMEOUT_MS;
  // Outer budget slightly above inner AbortController so abort wins first.
  const outerMs = timeoutMs + 500;
  logAt("info", `[cinepro] resolve mode=${mode} timeoutMs=${timeoutMs}`);
  const streams = await withCircuit(
    "cinepro",
    async () => {
      const r = await withTimeout(
        resolveCinepro(tmdbId, mediaType, season, episode, { timeoutMs }),
        outerMs
      );
      // Outer race null = hang past budget; treat as failure for the circuit.
      if (r == null) throw new Error(`cinepro_timeout_${timeoutMs}`);
      return r;
    },
    // Empty list = title miss, not outage — do not open the circuit.
    { isSuccess: (r) => r != null }
  );
  if (!streams?.length) return [];
  // Soft-keep: CinePro proxy URLs often fail cold verify from scraper but play via
  // home /api/hls. Keep the full LordFlix-size list; auto-default still prefers
  // verified:true + probe.ok. VixSrc/Luna de-dupe vs native runs in mergeSourceEntries.
  const entries = streams.map(providerToEntry);
  const verified = await filterVerifiedEntries(entries, { softKeep: true });
  const softCount = verified.filter((e) => e.verified === false).length;
  logAt(
    "info",
    `[cinepro] ${streams.length} raw → ${verified.length} kept (${softCount} soft/unverified) mode=${mode}`
  );
  return verified;
}

/**
 * CinemaOS /api/cinemaosv2 — progressive MP4 (MovieBox via worker proxies).
 * Empty array = title miss (success). Timeouts / thrown errors still fail
 * the circuit — five title-misses must not open it for every other title.
 */
async function resolveCinemaosEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  if (!isProviderEnabled("cinemaos")) return [];
  const streams = await withCircuit(
    "cinemaos",
    async () => {
      const r = await withTimeout(
        resolveCinemaos(tmdbId, mediaType, season, episode),
        CINEMAOS_OUTER_TIMEOUT_MS
      );
      if (r == null) throw new Error("cinemaos_timeout");
      return r;
    },
    { isSuccess: (r) => r != null }
  );
  if (!streams?.length) return [];
  logAt("info", `[cinemaos] ${streams.length} stream(s) for ${tmdbId}`);
  return streams.map(providerToEntry);
}

/**
 * Videasy / Vidking API — Cypher MP4 ladder + Yoru HLS. Empty = title miss.
 * Stamp maxHeight from the quality token so 1080 beats Luna 720 on the fast path.
 */
async function resolveVideasyEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  if (!isProviderEnabled("videasy")) return [];
  const streams = await withCircuit(
    "videasy",
    async () => {
      const r = await withTimeout(
        resolveVideasy(tmdbId, mediaType, season, episode),
        VIDEASY_OUTER_TIMEOUT_MS
      );
      if (r == null) throw new Error("videasy_timeout");
      return r;
    },
    { isSuccess: (r) => r != null }
  );
  if (!streams?.length) return [];
  logAt("info", `[videasy] ${streams.length} stream(s) for ${tmdbId}`);
  return streams.map((stream) => {
    const entry = providerToEntry(stream);
    const height = parseInt(stream.quality, 10);
    if (Number.isFinite(height) && height > 0) {
      entry.maxHeight = height;
      entry.ladder = stream.ladder?.length ? stream.ladder : [height];
      entry.qualitySource = "label";
    }
    return entry;
  });
}

/**
 * Vidrock — AES-GCM English HLS + Astra MP4 ladder. Empty = title miss.
 * Always raced (never skipped) — measured anime coverage on TMDB TV ids.
 */
async function resolveVidrockEntries(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<SourceEntry[]> {
  if (!isProviderEnabled("vidrock")) return [];
  const streams = await withCircuit(
    "vidrock",
    async () => {
      const r = await withTimeout(
        resolveVidrock(tmdbId, mediaType, season, episode),
        VIDROCK_OUTER_TIMEOUT_MS
      );
      if (r == null) throw new Error("vidrock_timeout");
      return r;
    },
    { isSuccess: (r) => r != null }
  );
  if (!streams?.length) return [];
  logAt("info", `[vidrock] ${streams.length} stream(s) for ${tmdbId}`);
  return streams.map(providerToEntry);
}

/**
 * Settle window after the FIRST playable source lands, before returning.
 *
 * This is a peer-collection window, not a correctness requirement: every arm
 * that misses it still merges into the result cache via `onLateSources` /
 * `onLateEntries`, and the client independently polls progressively AND runs
 * a parallel `full` request. So the only thing a long grace buys is a wider
 * roster in the FIRST response — at a direct, per-request cost to time-to-
 * first-frame.
 *
 * It was 2_500ms, which dominated the whole resolve. Measured on this host:
 * vixsrc answered at 760ms, notorrent at 1005ms, yet `lastScrape.totalMs` was
 * 3111ms — i.e. ~80% of every resolve was this timer idling on a roster the
 * client was already going to receive anyway.
 *
 * 300ms is chosen from the same measurement: the two fastest arms land 245ms
 * apart, so this still captures a near-simultaneous peer (the actual point of
 * a settle window) while cutting ~2.2s off first frame. Slower arms
 * (vidlink ~2.0s, cinemaos ~3.0s) become late-merge, which is exactly the
 * path they already take on a cache hit.
 */
const FIRST_HIT_SETTLE_MS = 300;
/**
 * FAST path: settle briefly and return. This one gates time-to-first-frame, so
 * a thin first answer is the right trade — the client starts playing on it while
 * the parallel `full` request and progressive polling fill the roster in.
 */
const FAST_FIRST_GRACE_MS = FIRST_HIT_SETTLE_MS;
/** Hard ceiling for the entire fast multi-API race (client timeout is 8s). */
const FAST_MAX_WAIT_MS = 7_500;
/**
 * FULL path: wait for peers. Do NOT reuse the fast settle here.
 *
 * The full request does not gate first frame — `fast` has already answered and
 * playback has started — so its actual job is to come back with a COMPLETE
 * roster. Sharing the 300ms fast settle made it return whichever single provider
 * answered first (Vixsrc at ~1027ms) and pushed every other provider past the
 * finish line into `onLateEntries`, i.e. into the cache only:
 *
 *   [scrape] full API race -> 1 source(s) in 1327ms
 *   [scrape] full 1 source(s) (cap 20)
 *
 * That is what produced "only 3 sources" in the picker and made the roster
 * appear to trickle in: the client's progressive poll stops once it sees
 * SOURCE_POLL_TARGET healthy sources, so late arrivals could sit in the cache
 * unseen for the rest of the session. Waiting ~2.5s here costs nothing the
 * viewer can perceive and is the difference between a 1-source and a
 * ~10-source roster.
 */
const FULL_FIRST_GRACE_MS = 2_500;
/** Leave time inside the route budget for measured probes and serialization. */
const FULL_API_MAX_WAIT_MS = 7_500;

/**
 * Fast path: race multi-API providers (no Playwright) so TTFF is stable for TV.
 * Returns after first hit + grace, but late arms still call onLateSources so the
 * result cache keeps filling (discarding peers after return caused 1-server UI).
 */
async function resolveFastApiSources(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: { onLateSources?: (entries: SourceEntry[]) => void } = {}
): Promise<SourceEntry[]> {
  // Fast race: live providers only. Native Videasy (speedracelight enc=2) is
  // back on the race — the old enc-dec.app Videasy path is still dead.
  // CinePro uses the shorter fast budget so timeout can record circuit failure
  // instead of hanging past FAST_MAX_WAIT as a silent late-only arm.
  const race = await raceProviderArms<SourceEntry>(
    [
      { provider: "vixsrc", run: () => resolveVixsrcFast(tmdbId, mediaType, season, episode) },
      {
        provider: "notorrent",
        run: () => resolveNotorrentEntries(tmdbId, mediaType, season, episode),
      },
      {
        provider: "vidlink",
        run: () => resolveVidlinkEntries(tmdbId, mediaType, season, episode),
      },
      {
        provider: "cinepro",
        run: () =>
          resolveCineproEntries(tmdbId, mediaType, season, episode, {
            mode: "fast",
            timeoutMs: CINEPRO_FAST_TIMEOUT_MS,
          }),
      },
      {
        provider: "cinemaos",
        run: () => resolveCinemaosEntries(tmdbId, mediaType, season, episode),
      },
      {
        provider: "videasy",
        run: () => resolveVideasyEntries(tmdbId, mediaType, season, episode),
      },
      {
        provider: "vidrock",
        run: () => resolveVidrockEntries(tmdbId, mediaType, season, episode),
      },
    ],
    {
      firstHitGraceMs: FAST_FIRST_GRACE_MS,
      maxWaitMs: FAST_MAX_WAIT_MS,
      onLateEntries: (_provider, entries) => options.onLateSources?.(entries),
      onOutcome: (outcome) => {
        logAt(
          outcome.status === "error" ? "warn" : "info",
          `[provider] fast request provider=${outcome.provider} status=${outcome.status} count=${outcome.count} ms=${outcome.ms} late=${outcome.late}${outcome.error ? ` error=${outcome.error}` : ""}`
        );
      },
    }
  );

  logAt(
    "info",
    `[scrape] fast race → ${race.entries.length} source(s) in ${race.totalMs}ms (first@${race.firstHitMs ?? "—"}ms)`
  );
  return [...race.entries];
}

function countUniqueSources(entries: SourceEntry[]): number {
  return mergeSourceEntries(entries).length;
}

/**
 * Fan out embeds with at most MAX_BROWSERS in-flight (pool-safe).
 * Stops scheduling new embeds once `targetCount` unique sources are collected.
 * Cancel flags stop late tryScrapeUrl pushes after per-embed / global budget wins.
 *
 * Phase 3: caller supplies the wave list (primary or secondary) and optional
 * residual `budgetMs` so both waves share one PW_WAIT_MS wall.
 */
async function playwrightFallback(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: {
    skipVerify?: boolean;
    targetCount?: number;
    /** Wave embed list — defaults to primary roster. */
    embeds?: EmbedSourceSpec[];
    /** Hard wall for this wave (ms). Defaults to PW_WAIT_MS. */
    budgetMs?: number;
    /** Log tag for wave diagnostics. */
    wave?: "primary" | "secondary";
    /** Exhausted-roster recovery may claim one immediate half-open host probe. */
    forceDeadHostProbe?: boolean;
  } = {}
): Promise<SourceEntry[]> {
  if (!isProviderEnabled("playwright") || !canAttempt("playwright")) {
    logAt("info", `[scrape] Playwright skipped (kill switch or circuit open)`);
    return [];
  }

  const collected: SourceEntry[] = [];
  const skipVerify = options.skipVerify ?? false;
  const targetCount = options.targetCount ?? MAX_SOURCES;
  const waveBudgetMs = options.budgetMs ?? PW_WAIT_MS;
  const wave = options.wave ?? "primary";
  const started = Date.now();
  const inFlightCancels: { cancelled: boolean }[] = [];

  const cancelAllInFlight = (): void => {
    for (const c of inFlightCancels) c.cancelled = true;
  };

  const embedSources =
    options.embeds ?? buildPrimarySourceUrls(tmdbId, mediaType, season, episode);
  // Stable order: primary specs first (secondary wave is already all secondary).
  embedSources.sort((a, b) =>
    a.priority === b.priority ? 0 : a.priority === "primary" ? -1 : 1
  );

  if (waveBudgetMs <= 0 || embedSources.length === 0) {
    logAt(
      "info",
      `[scrape] Playwright ${wave} wave skipped (budget=${waveBudgetMs}ms, embeds=${embedSources.length})`
    );
    return [];
  }

  logAt(
    "info",
    `[scrape] Playwright ${wave} wave for ${tmdbId}: ${embedSources.length} embed(s), budget ${waveBudgetMs}ms${skipVerify ? " (skipVerify)" : ""}`
  );

  let cursor = 0;
  let stopScheduling = false;

  const runOne = async (spec: EmbedSourceSpec): Promise<void> => {
    if (stopScheduling) return;

    let host = "";
    try {
      host = new URL(spec.url).hostname;
    } catch {
      host = "";
    }
    if (host && isEmbedHostDead(host, options.forceDeadHostProbe ?? false)) {
      logAt("debug", `[scrape] skipping dead embed host: ${host}`);
      return;
    }

    const cancelState = { cancelled: false };
    inFlightCancels.push(cancelState);
    const perEmbedMs = spec.workerBudgetMs;

    try {
      const result = await Promise.race([
        tryScrapeUrl(spec.url, spec.waitUntil, {
          skipVerify,
          gotoTimeoutMs: spec.gotoTimeoutMs,
          captureWaitMs: spec.captureWaitMs,
          cancelled: cancelState,
        }),
        new Promise<ScrapeResult>((resolve) =>
          setTimeout(() => {
            cancelState.cancelled = true;
            resolve({ streamUrl: null, sources: [], error: "timed out" });
          }, perEmbedMs)
        ),
      ]);

      if (host) {
        // A bare "timed out" (this function's own outer perEmbedMs race
        // firing because tryScrapeUrl never settled at all) is NOT the same
        // as a fast, legitimate "no stream for this title" miss — the host
        // hung completely rather than reaching a conclusion. Left uncounted,
        // a host that reliably hangs (rather than erroring) burns its full
        // worker budget on every future scrape forever without ever
        // tripping the dead-host circuit — the enrich HARD TIMEOUT waste
        // this tracker exists to prevent. Count it as a failure alongside
        // hard nav errors; the existing 2-strike + instant-heal-on-success
        // policy in embed-health.ts already keeps this bounded and
        // self-healing for a merely occasional slow response.
        const timedOut = result.error === "timed out";
        recordEmbedOutcome(
          host,
          result.sources.length > 0 || (!isHardEmbedFailure(result.error) && !timedOut)
        );
      }

      // Timeout/cancel path returns empty sources — never push late discards.
      if (cancelState.cancelled && !result.sources.length) {
        if (result.error && result.error !== "cancelled") {
          logAt("info", `[scrape] embed miss (${providerFromEmbed(spec.url)}): ${result.error}`);
        }
        return;
      }

      if (result.sources.length) {
        collected.push(...result.sources);
        if (countUniqueSources(collected) >= targetCount) {
          stopScheduling = true;
          cancelAllInFlight();
        }
      } else if (result.error && result.error !== "cancelled") {
        logAt("info", `[scrape] embed miss (${providerFromEmbed(spec.url)}): ${result.error}`);
      }
    } finally {
      const idx = inFlightCancels.indexOf(cancelState);
      if (idx >= 0) inFlightCancels.splice(idx, 1);
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopScheduling) {
      const idx = cursor++;
      if (idx >= embedSources.length) return;
      const spec = embedSources[idx]!;
      try {
        await runOne(spec);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logAt("info", `[scrape] embed error (${providerFromEmbed(spec.url)}): ${message}`);
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(MAX_BROWSERS, embedSources.length) }, () =>
      worker()
    );
    await Promise.race([
      Promise.all(workers),
      new Promise<void>((resolve) => setTimeout(resolve, waveBudgetMs)),
    ]);
    // Global budget won or all workers done — stop new work + cancel in-flight embeds.
    stopScheduling = true;
    cancelAllInFlight();

    const ms = Date.now() - started;
    // Snapshot so late cancelled workers cannot mutate the returned array.
    const snapshot = collected.slice();
    // Empty embeds for a title is not a Playwright outage — do not trip the circuit
    // (was recordFailure("no_embed_streams") → circuit open → skip all future embeds).
    recordSuccess("playwright", ms);
    if (!snapshot.length) {
      logAt(
        "info",
        `[scrape] Playwright ${wave} finished with 0 embed streams for ${tmdbId} (${ms}ms)`
      );
    }
    const debugPath = await flushDebugDump();
    if (debugPath) logAt("info", `[debug] scraper dump written: ${debugPath}`);
    return snapshot;
  } catch (e: unknown) {
    const ms = Date.now() - started;
    stopScheduling = true;
    cancelAllInFlight();
    const message = e instanceof Error ? e.message : String(e);
    recordFailure("playwright", ms, message);
    const debugPath = await flushDebugDump();
    if (debugPath) logAt("info", `[debug] scraper dump written (after error): ${debugPath}`);
    return collected.slice();
  }
}

/**
 * Prefer H264 HLS, then non-HEVC, then at most one HEVC fallback — soft-keep verify.
 */
async function filterAndKeepPwSources(pwSources: SourceEntry[]): Promise<SourceEntry[]> {
  if (!pwSources.length) return [];
  const preferred = pwSources.filter((s) => s.url.includes(".m3u8") && !isHevcStream(s.url));
  const restNonHevc = pwSources.filter(
    (s) => !preferred.includes(s) && !isHevcStream(s.url)
  );
  const hevcCandidates = pwSources.filter((s) => isHevcStream(s.url));
  const kept = [...preferred, ...restNonHevc, ...hevcCandidates];
  const verifiedKept = await filterVerifiedEntries(kept, { softKeep: true });
  const afterHevc =
    preferred.length +
    restNonHevc.length +
    Math.min(MAX_HEVC_FALLBACK_SOURCES, hevcCandidates.length);
  const softCount = verifiedKept.filter((e) => e.verified === false).length;
  logAt(
    "info",
    `[scrape] PW sources before merge: ${pwSources.length}, after HEVC filter: ${afterHevc}, after verify: ${verifiedKept.length} (${softCount} soft) (hls=${preferred.length}, other=${restNonHevc.length}, hevcCandidates=${hevcCandidates.length})`
  );
  return verifiedKept;
}

/**
 * Additive merge for late fast arms / enrich.
 * `partial` stays true while the roster is thin or an explicit Ultra request
 * still has no verified 4K candidate. Auto/1080 keeps the original fast clear.
 */
function rosterNeedsPreferredQuality(sources: SourceEntry[]): boolean {
  const preferredHeight = currentQualityHintHeight();
  return (
    preferredHeight > 1080 &&
    !rosterHasPlayableHeight(sources, preferredHeight)
  );
}

function rosterDiscoveryPending(sources: SourceEntry[]): boolean {
  return (
    countAutoPlayableRosterSources(sources) < PARTIAL_CLEAR_MIN ||
    rosterNeedsPreferredQuality(sources)
  );
}

function mergeIntoCache(key: string, entries: SourceEntry[]): ScrapeResult | null {
  const existing = getCached(key);
  const combined = [...(existing?.sources ?? []), ...entries];
  const merged = buildMergedResult(combined);
  if (!merged.streamUrl) return null;
  const discoveryPending = rosterDiscoveryPending(merged.sources);
  const withPartial: ScrapeResult = {
    ...merged,
    partial: discoveryPending ? true : undefined,
  };
  setCachedResult(key, withPartial);
  return withPartial;
}

/** First-response flag: thin roster, or explicit Ultra still searching. */
function partialFlagForResult(sources: SourceEntry[]): true | undefined {
  return (
    partialForPlayableRoster(sources, PARTIAL_CLEAR_MIN) ||
    rosterNeedsPreferredQuality(sources)
  )
    ? true
    : undefined;
}

async function enrichMissingSources(
  collected: SourceEntry[],
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: {
    skipVidlink?: boolean;
    skipNotorrent?: boolean;
    /** Sync path must skip PW — 60s+ embeds block first frame. Background only. */
    skipPlaywright?: boolean;
    /** Let recovery probe one host even while its normal cooldown is active. */
    forceDeadHostProbe?: boolean;
  } = {}
): Promise<SourceEntry[]> {
  let result = [...collected];
  // Only measured seed rows and newly captured browser rows are health
  // evidence. Background API refreshes can return the same dead signed URL
  // without a probe; treating that duplicate as healthy previously suppressed
  // every secondary browser provider.
  let healthEvidence = [...collected];

  // Always pull API providers when under the hard cap (enc-dec outages just yield []).
  if (countUniqueSources(result) < MAX_SOURCES) {
    const skipVidlink =
      options.skipVidlink ||
      result.some((e) => e.provider.toLowerCase().includes("vidlink"));
    const skipNotorrent =
      options.skipNotorrent ||
      result.some(
        (e) =>
          e.provider.toLowerCase().includes("notorrent") ||
          e.label.toLowerCase().startsWith("pulse")
      );
    const bgApis = await resolveBackgroundApis(tmdbId, mediaType, season, episode, {
      skipVidlink,
      skipNotorrent,
    });
    if (bgApis.length) result = [...result, ...bgApis];
  }

  // Playwright is background-only (P0). Sync path returns API sources immediately.
  if (options.skipPlaywright) {
    logAt("info", `[scrape] skip Playwright on sync path (${countUniqueSources(result)} API sources)`);
    return result;
  }

  // Skip BOTH PW waves when the API roster is already healthy.
  // Vidking PW is often ~17s (over budget) and burns the only browser
  // (pool size 1). Threshold = VERIFIED_MIN_SKIP_SECONDARY (4) measured-
  // playable non-poison sources — Witcher S1E1: Luna+Quasar+Rock×3 in 921ms.
  // Vidrock stays on the API race; it is never skipped here.
  const prePwEvidence = mergeSourceEntries(healthEvidence);
  if (shouldSkipPlaywrightForHealthyRoster(prePwEvidence)) {
    const goodCount = countMeasuredPlayableRosterSources(prePwEvidence);
    logAt(
      "info",
      `[scrape] PW primary skipped (autoPlayable=${goodCount} ≥ ${VERIFIED_MIN_SKIP_SECONDARY})`
    );
    return result;
  }

  // Playwright embed fan-out — only from scheduleBackgroundEnrich.
  // Secondary only if fewer than VERIFIED_MIN_SKIP_SECONDARY measured-playable
  // sources remain after primary. Provider labels alone are not health evidence.
  // Both waves share one PW_WAIT_MS hard wall so enrich settles ~20s for PW.
  if (countUniqueSources(result) < MAX_SOURCES) {
    const pwWallStarted = Date.now();
    const need = MAX_SOURCES - countUniqueSources(result);
    const primaryEmbeds = buildPrimarySourceUrls(tmdbId, mediaType, season, episode);
    const primaryPw = await playwrightFallback(tmdbId, mediaType, season, episode, {
      skipVerify: true,
      targetCount: need,
      embeds: primaryEmbeds,
      budgetMs: PW_WAIT_MS,
      wave: "primary",
      forceDeadHostProbe: options.forceDeadHostProbe,
    });
    if (primaryPw.length) {
      const kept = await filterAndKeepPwSources(primaryPw);
      result = [...result, ...kept];
      healthEvidence = [...healthEvidence, ...kept];
    } else {
      logAt("info", `[scrape] PW primary sources before merge: 0`);
    }

    const goodCount = countMeasuredPlayableRosterSources(
      mergeSourceEntries(healthEvidence)
    );
    const elapsed = Date.now() - pwWallStarted;
    const remainingMs = PW_WAIT_MS - elapsed;
    if (
      goodCount < VERIFIED_MIN_SKIP_SECONDARY &&
      remainingMs >= SECONDARY_MIN_REMAINING_MS &&
      countUniqueSources(result) < MAX_SOURCES
    ) {
      const secondaryNeed = MAX_SOURCES - countUniqueSources(result);
      const secondaryEmbeds = buildSecondarySourceUrls(tmdbId, mediaType, season, episode);
      logAt(
        "info",
        `[scrape] PW secondary wave (autoPlayable=${goodCount} < ${VERIFIED_MIN_SKIP_SECONDARY}, remaining=${remainingMs}ms)`
      );
      const secondaryPw = await playwrightFallback(tmdbId, mediaType, season, episode, {
        skipVerify: true,
        targetCount: secondaryNeed,
        embeds: secondaryEmbeds,
        budgetMs: remainingMs,
        wave: "secondary",
        forceDeadHostProbe: options.forceDeadHostProbe,
      });
      if (secondaryPw.length) {
        const kept = await filterAndKeepPwSources(secondaryPw);
        result = [...result, ...kept];
      }
    } else if (goodCount >= VERIFIED_MIN_SKIP_SECONDARY) {
      logAt(
        "info",
        `[scrape] PW secondary skipped (autoPlayable=${goodCount} ≥ ${VERIFIED_MIN_SKIP_SECONDARY})`
      );
    } else if (remainingMs < SECONDARY_MIN_REMAINING_MS) {
      logAt(
        "info",
        `[scrape] PW secondary skipped (remaining ${remainingMs}ms < ${SECONDARY_MIN_REMAINING_MS}ms)`
      );
    }
  }

  return result;
}

/** Keys that already finished one full enrich pass (avoid re-scrape storm every poll). */
const enrichCompletedKeys = new Set<string>();
const enrichmentCoalescer = new EnrichmentCoalescer();

function cachedSourcesForTargets(targetKeys: readonly string[]): SourceEntry[] {
  return targetKeys.flatMap((targetKey) => getCached(targetKey)?.sources ?? []);
}

function publishEnrichmentResult(
  targetKeys: readonly string[],
  sharedResult: ScrapeResult
): number {
  let largestRoster = 0;
  for (const targetKey of targetKeys) {
    const latest = getCached(targetKey)?.sources ?? [];
    const merged = buildMergedResult([...latest, ...sharedResult.sources]);
    if (!merged.streamUrl) continue;
    setCachedResult(targetKey, { ...merged, partial: undefined });
    largestRoster = Math.max(largestRoster, merged.sources.length);
  }
  return largestRoster;
}

function finishEnrichmentTargets(
  targetKeys: readonly string[],
  sharedResult: ScrapeResult | null
): number {
  const largestRoster = sharedResult
    ? publishEnrichmentResult(targetKeys, sharedResult)
    : 0;
  for (const targetKey of targetKeys) {
    const existing = getCached(targetKey);
    if (existing?.partial) {
      setCachedResult(targetKey, { ...existing, partial: undefined });
    }
    if (countAutoPlayableRosterSources(existing?.sources ?? []) >= PARTIAL_CLEAR_MIN) {
      enrichCompletedKeys.add(targetKey);
    } else {
      enrichCompletedKeys.delete(targetKey);
    }
  }
  return largestRoster;
}

function scheduleBackgroundEnrich(
  key: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: { force?: boolean; forceDeadHostProbe?: boolean } = {}
): void {
  const jobKey = coalescedEnrichmentKey(key);
  if (
    !options.force &&
    enrichCompletedKeys.has(key) &&
    !enrichmentCoalescer.hasJob(jobKey)
  ) {
    return;
  }
  const registration = enrichmentCoalescer.join(jobKey, key);
  enrichCompletedKeys.delete(key);
  if (!registration.leader) {
    logAt("info", `[scrape] coalesced background enrich target ${key} into ${jobKey}`);
    return;
  }
  logAt("info", `[scrape] background enrich for ${jobKey}`);

  const enrichStarted = Date.now();
  let seedCount = 0;

  // Hard timeout guarantees the promise settles — UI must never await forever.
  const enrichWork = Promise.resolve().then(async (): Promise<ScrapeResult | null> => {
    const seed = mergeSourceEntries(cachedSourcesForTargets(registration.targets()));
    seedCount = seed.length;
    const needsHdRescue = !rosterHasPlayableHeight(seed, 1080);
    const enriched = await enrichMissingSources(
      seed,
      tmdbId,
      mediaType,
      season,
      episode,
      {
        forceDeadHostProbe: options.forceDeadHostProbe || needsHdRescue,
      }
    );
    // Provider arms may settle while the browser wave runs, so merge every
    // joined pass's latest cache after enrichment instead of reusing the seed.
    const latest = cachedSourcesForTargets(registration.targets());
    let merged = buildMergedResult([...latest, ...enriched]);
    if (merged.streamUrl) {
      const expectedDurationS =
        (await lookupTmdb(tmdbId, mediaType))?.runtimeSeconds ?? 0;
      merged = await applyLatencyProbes(merged, mediaType, expectedDurationS);
      return merged.streamUrl ? { ...merged, partial: undefined } : null;
    }
    return null;
  });

  const finishEnrichment = (sharedResult: ScrapeResult | null): void => {
    const targetKeys = registration.finish();
    if (!targetKeys) return;
    const largestRoster = finishEnrichmentTargets(targetKeys, sharedResult);
    if (sharedResult) {
      logAt(
        "info",
        `[scrape] enriched ${jobKey} → ${largestRoster} source(s) across ${targetKeys.length} cache(s) in ${Date.now() - enrichStarted}ms`
      );
      lastScrapeLifecycle = {
        ...lastScrapeLifecycle,
        lastEnrichMs: Date.now() - enrichStarted,
        lastEnrichSources: largestRoster,
        lastEnrichAt: Date.now(),
      };
    } else {
      logAt("info", `[scrape] enrich empty for ${jobKey} (seed ${seedCount})`);
    }
  };

  const settledWork = enrichWork.then(
    (sharedResult) => {
      finishEnrichment(sharedResult);
    },
    (error: unknown) => {
      logAt("error", `[scrape] enrich failed for ${jobKey}:`, error);
      finishEnrichment(null);
    }
  );

  // A hard timeout ends the UI's pending state but deliberately retains the
  // active leader until its underlying work settles. Late success still
  // publishes once, and new fast/full targets join instead of spawning a
  // concurrent browser wave.
  void raceWithHardTimeout(
    settledWork,
    ENRICH_HARD_TIMEOUT_MS,
    () => {
      registration.markTimedOut();
      logAt("warn", `[scrape] enrich HARD TIMEOUT ${ENRICH_HARD_TIMEOUT_MS}ms for ${jobKey}`);
    }
  ).catch((error: unknown) => {
    logAt("error", `[scrape] enrich timeout race failed for ${jobKey}:`, error);
  });
}

function captureScrapeTiming(
  key: string,
  fast: boolean,
  totalMs: number
): void {
  const circuits = getAllCircuitSnapshots();
  const providers: ProviderTiming[] = (
    Object.keys(circuits) as ProviderId[]
  ).map((id) => {
    const snap = circuits[id];
    return {
      provider: id,
      ms: snap.lastMs ?? 0,
      ok: snap.lastOk ?? false,
      at: snap.lastAt ?? 0,
      error: snap.lastError ?? undefined,
    };
  });
  lastScrapeTiming = {
    at: Date.now(),
    key,
    fast,
    totalMs,
    providers: providers.filter((p) => p.at > 0),
  };
}

async function scrapeStream(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: { fast?: boolean; noCache?: boolean } = {}
): Promise<ScrapeResult> {
  if (mediaType === "tv" && (season == null || episode == null)) {
    return { streamUrl: null, sources: [], error: "TV requires season and episode." };
  }

  const scrapeStarted = Date.now();
  // Start metadata lookup beside provider work. Full-source probes use the
  // runtime to reject previews; the fast path never waits for this promise.
  const expectedDurationPromise = lookupTmdb(tmdbId, mediaType).then(
    (metadata) => metadata?.runtimeSeconds ?? 0
  );
  const key = resultCacheKey(
    tmdbId,
    mediaType,
    season,
    episode,
    currentQualityHintHeight(),
    Boolean(options.fast),
    currentContentClass()
  );
  const cached = getCached(key);
  const underCap = cached != null && cached.sources.length < MAX_SOURCES;
  const bypassCache = options.noCache && cached != null;

  if (cached && !bypassCache) {
    logAt("info", `[cache] hit for ${key} (${cached.sources.length} source(s))`);
    // Ghost roster: only soft-kept / probe-failed → force one re-enrich so cold UI can recover.
    const anyAuto =
      cached.sources.some((s) => s.verified !== false && s.probe?.ok !== false);
    if (!anyAuto && cached.sources.length > 0) {
      scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode, { force: true });
    } else if (underCap) {
      // One enrich pass max (unless nocache). partial only while that pass is in-flight
      // and roster is still under the clear floor.
      scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode);
    }
    const discoveryPending = rosterDiscoveryPending(cached.sources);
    return {
      ...cached,
      partial: (enrichmentCoalescer.hasTarget(key) && discoveryPending) || undefined,
    };
  }

  if (cached && bypassCache) {
    logAt(
      "info",
      `[scrape] nocache fresh resolve for ${key} (discarding ${cached.sources.length} cached)`
    );
    resultCache.delete(key);
    removeFromResultCacheOrder(key);
    enrichCompletedKeys.delete(key);
  }

  if (options.fast) {
    logAt("info", `[scrape] fast multi-API race for ${key}`);
    const fastCollected = await resolveFastApiSources(tmdbId, mediaType, season, episode, {
      onLateSources: (entries) => {
        const merged = mergeIntoCache(key, entries);
        if (merged) {
          logAt("info", `[scrape] late fast arm +${entries.length} → ${merged.sources.length} total for ${key}`);
        }
      },
    });
    const fastMerged = buildMergedResult(fastCollected);
    if (fastMerged.streamUrl) {
      const fastPartial = partialFlagForResult(fastMerged.sources);
      // Always schedule enrich; partial only while roster still thin.
      setCachedResult(key, { ...fastMerged, partial: fastPartial });
      logAt(
        "info",
        `[scrape] fast hit — ${fastMerged.sources.length} source(s), default: ${fastMerged.streamUrl.slice(0, 80)}`
      );
      captureScrapeTiming(key, true, Date.now() - scrapeStarted);
      lastScrapeLifecycle = {
        ...lastScrapeLifecycle,
        lastFastSources: fastMerged.sources.length,
        lastReturnedSources: fastMerged.sources.length,
        lastPartial: Boolean(fastPartial),
        lastKey: key,
        lastTotalMs: Date.now() - scrapeStarted,
      };
      scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode);
      return { ...fastMerged, partial: fastPartial };
    }
    captureScrapeTiming(key, true, Date.now() - scrapeStarted);
    scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode, {
      force: Boolean(options.noCache),
      forceDeadHostProbe: Boolean(options.noCache),
    });
    return {
      streamUrl: null,
      sources: [],
      error: "No fast source yet — full resolve in progress.",
      partial: true,
    };
  }

  logAt("info", `[scrape] full resolve for ${key}`);
  // Full path: race CinePro + Luna + CinemaOS + VidLink + secondary APIs, then PW embeds.
  const cineproPromise = resolveCineproEntries(tmdbId, mediaType, season, episode, {
    mode: "full",
    timeoutMs: CINEPRO_FULL_TIMEOUT_MS,
  }).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    logAt("warn", `[cinepro] early resolve error: ${message}`);
    return [] as SourceEntry[];
  });
  const lunaPromise = resolveVixsrcFast(tmdbId, mediaType, season, episode);
  const cinemaosPromise = resolveCinemaosEntries(tmdbId, mediaType, season, episode).catch(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logAt("warn", `[cinemaos] early resolve error: ${message}`);
      return [] as SourceEntry[];
    }
  );
  const vidlinkPromise = resolveVidlinkEntries(tmdbId, mediaType, season, episode).catch(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logAt("warn", `[vidlink-api] early resolve error: ${message}`);
      return [] as SourceEntry[];
    }
  );
  const videasyPromise = resolveVideasyEntries(tmdbId, mediaType, season, episode).catch(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logAt("warn", `[videasy] early resolve error: ${message}`);
      return [] as SourceEntry[];
    }
  );
  const vidrockPromise = resolveVidrockEntries(tmdbId, mediaType, season, episode).catch(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logAt("warn", `[vidrock] early resolve error: ${message}`);
      return [] as SourceEntry[];
    }
  );
  const notorrentPromise = resolveNotorrentEntries(tmdbId, mediaType, season, episode).catch(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logAt("warn", `[notorrent] early resolve error: ${message}`);
      return [] as SourceEntry[];
    }
  );

  const fullRace = await raceProviderArms<SourceEntry>(
    [
      { provider: "cinepro", run: () => cineproPromise },
      { provider: "vixsrc", run: () => lunaPromise },
      { provider: "cinemaos", run: () => cinemaosPromise },
      { provider: "vidlink", run: () => vidlinkPromise },
      { provider: "videasy", run: () => videasyPromise },
      { provider: "vidrock", run: () => vidrockPromise },
      { provider: "notorrent", run: () => notorrentPromise },
    ],
    {
      firstHitGraceMs: FULL_FIRST_GRACE_MS,
      maxWaitMs: FULL_API_MAX_WAIT_MS,
      onLateEntries: (provider, entries) => {
        const late = mergeIntoCache(key, entries);
        if (late) {
          logAt(
            "info",
            `[scrape] late full ${provider} +${entries.length} -> ${late.sources.length} total for ${key}`
          );
        }
      },
      onOutcome: (outcome) => {
        logAt(
          outcome.status === "error" ? "warn" : "info",
          `[provider] request=${key} provider=${outcome.provider} status=${outcome.status} count=${outcome.count} ms=${outcome.ms} late=${outcome.late}${outcome.error ? ` error=${outcome.error}` : ""}`
        );
      },
    }
  );
  logAt(
    "info",
    `[scrape] full API race -> ${fullRace.entries.length} source(s) in ${fullRace.totalMs}ms (first@${fullRace.firstHitMs ?? "-"}ms)`
  );
  const settledArms = await Promise.all([
    cineproPromise,
    lunaPromise,
    cinemaosPromise,
    vidlinkPromise,
    videasyPromise,
    vidrockPromise,
    notorrentPromise,
  ]);
  const expectedDurationS =
    (await withTimeout(expectedDurationPromise, 1_000)) ?? 0;
  let collected = mergeSourceEntries([...fullRace.entries, ...settledArms.flat()]);
  let merged = buildMergedResult(collected);

  if (merged.streamUrl) {
    logAt(
      "info",
      `[scrape] primary hit (${merged.sources.length}) — enriching toward ${MIN_SOURCES_TARGET}+ for ${key}`
    );
    // All API providers already participated in the progressive race. Do not
    // re-await a slow arm after a healthy peer won.
    collected = await enrichMissingSources(
      collected,
      tmdbId,
      mediaType,
      season,
      episode,
      {
        skipVidlink: true,
        skipNotorrent: true,
        skipPlaywright: true,
      }
    );
    merged = buildMergedResult(collected);
    if (!merged.streamUrl) {
      captureScrapeTiming(key, false, Date.now() - scrapeStarted);
      return { streamUrl: null, sources: [], error: merged.error || "Enrichment failed" };
    }
    merged = await applyLatencyProbes(merged, mediaType, expectedDurationS);
    const latestWhileProbing = getCached(key);
    if (latestWhileProbing?.sources.length) {
      merged = buildMergedResult(
        appendNewSourceIdentities(
          merged.sources,
          latestWhileProbing.sources,
          entryIdentity
        )
      );
    }
    setCachedResult(key, merged);
    logAt(
      "info",
      `[scrape] full ${merged.sources.length} source(s) (cap ${MAX_SOURCES}), default: ${(merged.streamUrl ?? "").slice(0, 80)}`
    );
    captureScrapeTiming(key, false, Date.now() - scrapeStarted);
    lastScrapeLifecycle = {
      ...lastScrapeLifecycle,
      lastFullSources: merged.sources.length,
      lastReturnedSources: merged.sources.length,
      lastPartial: Boolean(partialFlagForResult(merged.sources)),
      lastKey: key,
      lastTotalMs: Date.now() - scrapeStarted,
    };
    scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode, {
      force: Boolean(options.noCache),
      forceDeadHostProbe: Boolean(options.noCache),
    });
    return {
      ...merged,
      partial: partialFlagForResult(merged.sources),
    };
  }

  logAt("info", `[scrape] Luna miss — resolving background APIs + embeds for ${key}`);
  // Every API arm already had an independent chance in the race. Browser
  // discovery continues in the background rather than blocking this request.
  collected = await enrichMissingSources(
    collected,
    tmdbId,
    mediaType,
    season,
    episode,
    {
      skipVidlink: true,
      skipNotorrent: true,
      skipPlaywright: true,
    }
  );
  merged = buildMergedResult(collected);

  if (merged.streamUrl) {
    merged = await applyLatencyProbes(merged, mediaType, expectedDurationS);
    setCachedResult(key, merged);
    logAt(
      "info",
      `[scrape] ${merged.sources.length} source(s) ready, default: ${(merged.streamUrl ?? "").slice(0, 80)}`
    );
    captureScrapeTiming(key, false, Date.now() - scrapeStarted);
    if (merged.sources.length < MAX_SOURCES) {
      scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode, {
        force: Boolean(options.noCache),
        forceDeadHostProbe: Boolean(options.noCache),
      });
      return {
        ...merged,
        partial: partialFlagForResult(merged.sources),
      };
    }
    return merged;
  }

  scheduleBackgroundEnrich(key, tmdbId, mediaType, season, episode, {
    force: true,
    forceDeadHostProbe: Boolean(options.noCache),
  });
  captureScrapeTiming(key, false, Date.now() - scrapeStarted);
  return {
    streamUrl: null,
    sources: [],
    error: merged.error || "No source yet — background resolution is in progress.",
    partial: true,
  };
}

function buildHealthPayload(): Record<string, unknown> {
  const circuits = getAllCircuitSnapshots();
  const timings: Record<string, { lastMs: number | null; lastAt: number | null; lastOk: boolean | null }> =
    {};
  for (const [id, snap] of Object.entries(circuits)) {
    timings[id] = {
      lastMs: snap.lastMs,
      lastAt: snap.lastAt,
      lastOk: snap.lastOk,
    };
  }

  return {
    ok: true,
    browsers: pool.browsers.length,
    queued: pool.queue.length,
    pool: {
      size: pool.browsers.length,
      live: pool.live,
      max: MAX_BROWSERS,
      queued: pool.queue.length,
      warming: pool.warming,
    },
    circuits,
    timings,
    lastScrape: lastScrapeTiming
      ? {
          at: lastScrapeTiming.at,
          key: lastScrapeTiming.key,
          fast: lastScrapeTiming.fast,
          totalMs: lastScrapeTiming.totalMs,
          providers: lastScrapeTiming.providers,
        }
      : null,
    scrapeLifecycle: {
      ...lastScrapeLifecycle,
      pwWaitMs: PW_WAIT_MS,
      enrichHardTimeoutMs: ENRICH_HARD_TIMEOUT_MS,
      enrichingNow: enrichmentCoalescer.activeCount,
    },
    lastProbe: getLastProbeSummary(),
    logLevel: ACTIVE_LOG_LEVEL,
  };
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url || "", `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.end(JSON.stringify(buildHealthPayload()));
    return;
  }

  if (url.pathname === "/scrape" || url.pathname === "/prefetch") {
    const tmdbId = Number(url.searchParams.get("tmdbId"));
    const mediaType = (url.searchParams.get("mediaType") || "movie") as "movie" | "tv";
    // Season 0 specials: do not use truthiness (0 is valid). Empty string → undefined.
    const seasonRaw = url.searchParams.get("season");
    const episodeRaw = url.searchParams.get("episode");
    const seasonNum = seasonRaw != null && seasonRaw !== "" ? Number(seasonRaw) : NaN;
    const episodeNum = episodeRaw != null && episodeRaw !== "" ? Number(episodeRaw) : NaN;
    const season = Number.isFinite(seasonNum) ? seasonNum : undefined;
    const episode = Number.isFinite(episodeNum) ? episodeNum : undefined;
    const fast = url.pathname === "/prefetch" || url.searchParams.get("fast") === "1";
    const noCache = url.searchParams.get("nocache") === "1";
    // Preferred height from player Settings (1080 / 2160). Ranking only — not a filter.
    const qhRaw = url.searchParams.get("qualityHint");
    const qhNum = qhRaw ? Number(qhRaw) : NaN;
    const qualityHintHeight =
      Number.isFinite(qhNum) && qhNum >= 1080 ? Math.min(qhNum, 4320) : 2160;
    const contentClass = parseContentClassParam(
      url.searchParams.get("contentClass"),
      url.searchParams.get("anime"),
      mediaType
    );

    if (!tmdbId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing tmdbId" }));
      return;
    }

    // Scoped to this request's async context — see `qualityHintStore`. No
    // reset needed (and no reset RACE): the value dies with the context.
    await qualityHintStore.run(qualityHintHeight, () =>
      contentClassStore.run(contentClass, async () => {
        try {
          const result = await scrapeStream(tmdbId, mediaType, season, episode, { fast, noCache });
          res.end(JSON.stringify(result));
        } catch (e: unknown) {
          res.statusCode = 500;
          const message = e instanceof Error ? e.message : String(e);
          res.end(JSON.stringify({ streamUrl: null, sources: [], error: message }));
        }
      })
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

/** One-line boot signal so ops can prove CinePro gate state after flag flips. */
function logCineproBootState(): void {
  const configured = isCineproConfigured();
  const enabled = isProviderEnabled("cinepro");
  const permanent = process.env.PROVIDER_CINEPRO?.trim().toLowerCase();
  const evalUntil = process.env.CINEPRO_EVAL_UNTIL?.trim();
  let reason: string;
  if (!configured) {
    reason = "CINEPRO_URL unset";
  } else if (enabled) {
    if (permanent === "1" || permanent === "true" || permanent === "on" || permanent === "yes") {
      reason = "PROVIDER_CINEPRO";
    } else {
      reason = `CINEPRO_EVAL_UNTIL=${evalUntil || "?"}`;
    }
  } else if (
    permanent === "0" ||
    permanent === "false" ||
    permanent === "off" ||
    permanent === "no"
  ) {
    reason = "PROVIDER_CINEPRO kill";
  } else {
    reason = "quarantined (URL is not an enable switch)";
  }
  logAt(
    "info",
    `[cinepro] boot: enabled=${enabled} configured=${configured} reason=${reason} fastTimeoutMs=${CINEPRO_FAST_TIMEOUT_MS} fullTimeoutMs=${CINEPRO_FULL_TIMEOUT_MS}`
  );
}

warmBrowsers();
server.listen(PORT, () => {
  console.log(`[stream-scraper] listening on http://localhost:${PORT}`);
  logCineproBootState();
  // Pre-warm cinepro-core's cache for popular titles so the CinePro arm returns
  // instant sources instead of timing out on cold builds (see cinepro-warmer.ts).
  startCineproWarmer({
    isCineproConfigured,
    isCineproEnabled: () => isProviderEnabled("cinepro"),
  });
});

const shutdown = async () => {
  for (const b of pool.browsers) await b.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
