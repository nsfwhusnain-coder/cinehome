#!/usr/bin/env bun
/**
 * CineHome playback smoke harness (PR-01 / M0).
 *
 * In-container / against-server scraper smoke — no browser TTFF.
 * Records scrape_fast_ms, scrape_sources, provider labels, streamUrl y/n.
 *
 * Usage (inside container after scripts are in the image):
 *   docker exec cinehome bun /app/scripts/smoke-playback.ts
 *
 * Pre-bake (script not yet in image) — pipe via stdin:
 *   docker exec -i cinehome bun - < scripts/smoke-playback.ts
 *
 * From host via SSH:
 *   ssh hussyserver 'docker exec cinehome bun /app/scripts/smoke-playback.ts'
 *   # or curl-only fallback if script not yet in image:
 *   ssh -o BatchMode=yes hussyserver \
 *     'docker exec cinehome curl -sS --max-time 90 \
 *       "http://127.0.0.1:3030/scrape?tmdbId=71912&mediaType=tv&season=1&episode=1&fast=1"'
 *
 * Env:
 *   SCRAPER_URL   base URL of scraper (default http://127.0.0.1:3030)
 *                 Accepts trailing /scrape (stripped to base).
 *   NOCACHE=1     append nocache=1 on fast and full scrape URLs (cold / re-enrich).
 *                 Without it, full-after-fast is almost always a cache hit (~1ms)
 *                 and does not await background multi-provider enrich.
 *   SKIP_FULL=1   skip optional full follow-up call (cache follow-up unless NOCACHE)
 *   FULL_TIMEOUT_MS  full scrape timeout (default 120000)
 *   FAST_TIMEOUT_MS  fast scrape timeout (default 90000)
 *   HEALTH_TIMEOUT_MS health timeout (default 5000)
 *   FORMAT=table|json|both  output format (default both)
 *
 * Note: host port 4445 is the Next app, not the scraper. Scraper is internal :3030 only.
 * Exit 0: health ok AND ≥1 source AND streamUrl present. Else exit 1.
 */

const DEFAULT_SCRAPER_BASE = "http://127.0.0.1:3030";
const WITCHER_TMDB_ID = 71912;
const WITCHER_SEASON = 1;
const WITCHER_EPISODE = 1;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_FAST_TIMEOUT_MS = 90_000;
const DEFAULT_FULL_TIMEOUT_MS = 120_000;

type OutputFormat = "table" | "json" | "both";

interface ScraperSession {
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders?: Record<string, string>;
}

interface SourceEntry {
  url: string;
  quality: string;
  label: string;
  provider: string;
  session?: ScraperSession;
}

interface ScrapeResult {
  streamUrl: string | null;
  sources: SourceEntry[];
  error?: string;
}

interface HealthResult {
  ok: boolean;
  browsers?: number;
  queued?: number;
}

interface ScrapeCallMetrics {
  ok: boolean;
  ms: number;
  httpStatus: number | null;
  sources: number;
  providers: string[];
  labels: string[];
  streamUrlPresent: boolean;
  error: string | null;
}

interface SmokeReport {
  timestamp: string;
  scraperBase: string;
  title: string;
  tmdbId: number;
  mediaType: "tv";
  season: number;
  episode: number;
  nocache: boolean;
  health: {
    ok: boolean;
    ms: number;
    httpStatus: number | null;
    body: HealthResult | null;
    error: string | null;
  };
  scrape_fast_ms: number | null;
  scrape_sources: number;
  scrape_full_ms: number | null;
  scrape_full_sources: number | null;
  /** Without nocache, full is a cache follow-up after fast — not enrich wall time. */
  scrape_full_mode: "skipped" | "cache_followup" | "re_enrich";
  providers: string[];
  labels: string[];
  streamUrlPresent: boolean;
  fast: ScrapeCallMetrics | null;
  full: ScrapeCallMetrics | null;
  pass: boolean;
  reason: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

function parseFormat(raw: string | undefined): OutputFormat {
  const v = (raw || "both").trim().toLowerCase();
  if (v === "table" || v === "json" || v === "both") return v;
  return "both";
}

function normalizeScraperBase(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (base.endsWith("/scrape")) {
    base = base.slice(0, -"/scrape".length);
  }
  if (base.endsWith("/prefetch")) {
    base = base.slice(0, -"/prefetch".length);
  }
  return base.replace(/\/+$/, "") || DEFAULT_SCRAPER_BASE;
}

function providerLabels(sources: SourceEntry[]): { providers: string[]; labels: string[] } {
  const providers: string[] = [];
  const labels: string[] = [];
  const seenP = new Set<string>();
  const seenL = new Set<string>();
  for (const s of sources) {
    const p = (s.provider || "").trim() || "(unknown)";
    const l = (s.label || "").trim() || "(none)";
    if (!seenP.has(p)) {
      seenP.add(p);
      providers.push(p);
    }
    if (!seenL.has(l)) {
      seenL.add(l);
      labels.push(l);
    }
  }
  return { providers, labels };
}

function hasPlayableSource(data: ScrapeResult): boolean {
  if (!Array.isArray(data.sources) || data.sources.length < 1) return false;
  const streamUrlOk = typeof data.streamUrl === "string" && data.streamUrl.trim().length > 0;
  if (streamUrlOk) return true;
  return data.sources.some((s) => typeof s.url === "string" && s.url.trim().length > 0);
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number
): Promise<{ status: number; ms: number; data: T | null; error: string | null; raw: string }> {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    const ms = Math.round(performance.now() - started);
    let data: T | null = null;
    let error: string | null = null;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      error = `Invalid JSON (status ${res.status}): ${raw.slice(0, 200)}`;
    }
    return { status: res.status, ms, data, error, raw };
  } catch (e: unknown) {
    const ms = Math.round(performance.now() - started);
    const message = e instanceof Error ? e.message : String(e);
    return { status: 0, ms, data: null, error: message, raw: "" };
  }
}

function toScrapeMetrics(
  status: number,
  ms: number,
  data: ScrapeResult | null,
  parseError: string | null
): ScrapeCallMetrics {
  if (!data) {
    return {
      ok: false,
      ms,
      httpStatus: status || null,
      sources: 0,
      providers: [],
      labels: [],
      streamUrlPresent: false,
      error: parseError || `HTTP ${status || "n/a"}`,
    };
  }
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const { providers, labels } = providerLabels(sources);
  const count = sources.length;
  const streamUrlPresent =
    typeof data.streamUrl === "string" && data.streamUrl.trim().length > 0;
  const playable = hasPlayableSource(data);
  return {
    ok: status >= 200 && status < 300 && count >= 1 && playable,
    ms,
    httpStatus: status,
    sources: count,
    providers,
    labels,
    streamUrlPresent,
    error: data.error ?? parseError,
  };
}

function buildScrapeUrl(
  scraperBase: string,
  params: URLSearchParams,
  opts: { fast?: boolean; nocache: boolean }
): string {
  const q = new URLSearchParams(params);
  if (opts.fast) q.set("fast", "1");
  if (opts.nocache) q.set("nocache", "1");
  return `${scraperBase}/scrape?${q.toString()}`;
}

function printTable(report: SmokeReport): void {
  const rows: [string, string][] = [
    ["timestamp", report.timestamp],
    ["scraper", report.scraperBase],
    ["title", report.title],
    ["nocache", report.nocache ? "yes" : "no"],
    ["health_ok", report.health.ok ? "yes" : "no"],
    ["health_ms", String(report.health.ms)],
    ["scrape_fast_ms", report.scrape_fast_ms == null ? "n/a" : String(report.scrape_fast_ms)],
    ["scrape_sources", String(report.scrape_sources)],
    ["scrape_full_ms", report.scrape_full_ms == null ? "n/a" : String(report.scrape_full_ms)],
    [
      "scrape_full_sources",
      report.scrape_full_sources == null ? "n/a" : String(report.scrape_full_sources),
    ],
    ["scrape_full_mode", report.scrape_full_mode],
    ["providers", report.providers.length ? report.providers.join(", ") : "(none)"],
    ["labels", report.labels.length ? report.labels.join(", ") : "(none)"],
    ["streamUrl", report.streamUrlPresent ? "yes" : "no"],
    ["pass", report.pass ? "PASS" : "FAIL"],
    ["reason", report.reason],
  ];

  const keyWidth = Math.max(...rows.map(([k]) => k.length));
  console.log("");
  console.log("=== CineHome smoke-playback ===");
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(keyWidth)}  ${v}`);
  }
  console.log("===============================");
}

async function main(): Promise<number> {
  const scraperBase = normalizeScraperBase(process.env.SCRAPER_URL || DEFAULT_SCRAPER_BASE);
  const skipFull = envFlag("SKIP_FULL");
  const nocache = envFlag("NOCACHE");
  const format = parseFormat(process.env.FORMAT);
  const healthTimeoutMs = envInt("HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS);
  const fastTimeoutMs = envInt("FAST_TIMEOUT_MS", DEFAULT_FAST_TIMEOUT_MS);
  const fullTimeoutMs = envInt("FULL_TIMEOUT_MS", DEFAULT_FULL_TIMEOUT_MS);

  const healthUrl = `${scraperBase}/health`;
  const scrapeParams = new URLSearchParams({
    tmdbId: String(WITCHER_TMDB_ID),
    mediaType: "tv",
    season: String(WITCHER_SEASON),
    episode: String(WITCHER_EPISODE),
  });

  const healthRes = await fetchJson<HealthResult>(healthUrl, healthTimeoutMs);
  const healthOk =
    healthRes.status >= 200 &&
    healthRes.status < 300 &&
    healthRes.data?.ok === true &&
    !healthRes.error;

  let fast: ScrapeCallMetrics | null = null;
  let full: ScrapeCallMetrics | null = null;

  if (healthOk) {
    const fastUrl = buildScrapeUrl(scraperBase, scrapeParams, { fast: true, nocache });
    const fastRes = await fetchJson<ScrapeResult>(fastUrl, fastTimeoutMs);
    fast = toScrapeMetrics(fastRes.status, fastRes.ms, fastRes.data, fastRes.error);

    if (!skipFull) {
      // Without nocache this is nearly always a result-cache hit after fast (~1ms)
      // and does not wait for scheduleBackgroundEnrich. Use NOCACHE=1 for re-enrich wall time.
      const fullUrl = buildScrapeUrl(scraperBase, scrapeParams, { nocache });
      const fullRes = await fetchJson<ScrapeResult>(fullUrl, fullTimeoutMs);
      full = toScrapeMetrics(fullRes.status, fullRes.ms, fullRes.data, fullRes.error);
    }
  }

  const scrape_full_mode: SmokeReport["scrape_full_mode"] = skipFull
    ? "skipped"
    : nocache
      ? "re_enrich"
      : "cache_followup";

  const bestProviders = (full?.sources ?? 0) > (fast?.sources ?? 0) ? full : fast;
  const scrapeSources = Math.max(fast?.sources ?? 0, full?.sources ?? 0);
  const streamUrlPresent = Boolean(fast?.streamUrlPresent || full?.streamUrlPresent);
  // Align with app playback gate: need sources and a streamUrl (app path requires both).
  const pass = healthOk && scrapeSources >= 1 && streamUrlPresent;
  let reason: string;
  if (!healthOk) {
    reason = `health failed: ${healthRes.error || `status ${healthRes.status}`}`;
  } else if (scrapeSources < 1) {
    reason =
      fast?.error ||
      full?.error ||
      "no sources from fast or full scrape (Witcher S1E1 tmdb 71912)";
  } else if (!streamUrlPresent) {
    reason = "sources present but streamUrl missing (playback API would fail)";
  } else {
    reason = "health ok, ≥1 source, streamUrl present";
  }

  const report: SmokeReport = {
    timestamp: new Date().toISOString(),
    scraperBase,
    title: "The Witcher S1E1",
    tmdbId: WITCHER_TMDB_ID,
    mediaType: "tv",
    season: WITCHER_SEASON,
    episode: WITCHER_EPISODE,
    nocache,
    health: {
      ok: healthOk,
      ms: healthRes.ms,
      httpStatus: healthRes.status || null,
      body: healthRes.data,
      error: healthOk ? null : healthRes.error || `status ${healthRes.status}`,
    },
    scrape_fast_ms: fast?.ms ?? null,
    scrape_sources: scrapeSources,
    scrape_full_ms: full?.ms ?? null,
    scrape_full_sources: full ? full.sources : null,
    scrape_full_mode,
    providers: bestProviders?.providers ?? [],
    labels: bestProviders?.labels ?? [],
    streamUrlPresent,
    fast,
    full,
    pass,
    reason,
  };

  if (format === "json" || format === "both") {
    console.log(JSON.stringify(report, null, 2));
  }
  if (format === "table" || format === "both") {
    printTable(report);
  }
  return pass ? 0 : 1;
}

const code = await main();
process.exit(code);

export {};
