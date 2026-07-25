#!/usr/bin/env bun
/**
 * CineHome ownership baseline.
 *
 * This is intentionally stricter than the legacy smoke harness:
 * - a returned URL is not considered playback success;
 * - first frame requires decoded dimensions plus advancing currentTime;
 * - API-advertised source metadata is compared with the source that actually
 *   attaches to the media element;
 * - seek and forced source-death recovery are measured in the browser.
 *
 * Run inside the production image so Playwright uses the same Chromium build:
 *   docker exec cinehome bun /tmp/ownership-baseline.ts all
 *
 * Required:
 *   STORAGE_STATE=/tmp/cinehome-baseline-storage.json
 *
 * Optional:
 *   CINEHOME_BASE_URL=http://127.0.0.1:3000
 *   OUT_DIR=/tmp/cinehome-ownership-baseline
 *   TITLE_LIMIT=21
 *   PLAYBACK_LIMIT=6
 *   FIRST_FRAME_TIMEOUT_MS=45000
 *   STEADY_WATCH_MS=12000
 *   SCRAPER_COLD=1
 *   WARM_REPEAT=1
 *   TARGET_SOURCE_TYPE=mp4
 *   TARGET_SOURCE_PROVIDER=Debrid
 *   TARGET_SOURCE_ID_INCLUDES=native-1080
 *   TARGET_RESELECT_ACTIVE=1
 *   SKIP_FAILOVER=1
 *   FAILOVER_SOURCE_TYPE=dash
 *   FAILOVER_SOURCE_PROVIDER=CinemaOS
 *   FAILOVER_SOURCE_ID_INCLUDES=native-1080
 *   FIXTURE_FILTER=Coherence
 *   CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/.../chrome-headless-shell
 */

import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getServerDisplayName } from "../../src/lib/playback/server-names";

type MediaType = "movie" | "tv";
type Phase = "resolution" | "playback" | "all";

interface Fixture {
  label: string;
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
  categories: string[];
  browser?: boolean;
  warmRepeat?: boolean;
  seek?: boolean;
  failover?: boolean;
}

interface SourceSummary {
  id: string;
  provider: string;
  label: string;
  origin: "embed" | "debrid" | null;
  quality: string;
  type: string;
  maxHeight: number | null;
  ladder: number[];
  qualitySource: string | null;
  codec: string | null;
  container: string | null;
  compat: string | null;
  verified: boolean | null;
  probeOk: boolean | null;
  probeTtfbMs: number | null;
  probeBytesPerSec: number | null;
  url: string;
}

interface ApiCall {
  ok: boolean;
  status: number;
  ms: number;
  cache: string | null;
  responseStatus: string | null;
  partial: boolean | null;
  sourceCount: number;
  defaultSource: Omit<SourceSummary, "url"> | null;
  sources: Array<Omit<SourceSummary, "url">>;
  error: string | null;
  _sources?: SourceSummary[];
}

interface BrowserState {
  atMs: number;
  currentTime: number;
  duration: number | null;
  readyState: number;
  networkState: number;
  paused: boolean;
  seeking: boolean;
  videoWidth: number;
  videoHeight: number;
  bufferedAhead: number;
  src: string;
  mediaError: number | null;
}

const FIXTURES: Fixture[] = [
  {
    label: "Fight Club",
    mediaType: "movie",
    tmdbId: 550,
    categories: ["movie", "catalog-mainstream", "older"],
    browser: true,
    warmRepeat: true,
    seek: true,
    failover: true,
  },
  {
    label: "Oppenheimer",
    mediaType: "movie",
    tmdbId: 872585,
    categories: ["movie", "new-release", "historical-failure"],
    browser: true,
  },
  {
    label: "Dune: Part Two",
    mediaType: "movie",
    tmdbId: 693134,
    categories: ["movie", "new-release"],
  },
  {
    label: "Casablanca",
    mediaType: "movie",
    tmdbId: 289,
    categories: ["movie", "classic"],
  },
  {
    label: "Seven Samurai",
    mediaType: "movie",
    tmdbId: 346,
    categories: ["movie", "classic", "international"],
  },
  {
    label: "The Thing",
    mediaType: "movie",
    tmdbId: 1091,
    categories: ["movie", "older"],
  },
  {
    label: "Coherence",
    mediaType: "movie",
    tmdbId: 220289,
    categories: ["movie", "obscure"],
    browser: true,
  },
  {
    label: "Tampopo",
    mediaType: "movie",
    tmdbId: 4203,
    categories: ["movie", "obscure", "international"],
  },
  {
    label: "The Witcher S1E1",
    mediaType: "tv",
    tmdbId: 71912,
    season: 1,
    episode: 1,
    categories: ["episode", "catalog-mainstream"],
    browser: true,
    warmRepeat: true,
    seek: true,
  },
  {
    label: "Shogun S1E1",
    mediaType: "tv",
    tmdbId: 126308,
    season: 1,
    episode: 1,
    categories: ["episode", "new-release", "international", "historical-failure"],
  },
  {
    label: "Fallout S1E1",
    mediaType: "tv",
    tmdbId: 106379,
    season: 1,
    episode: 1,
    categories: ["episode", "new-release"],
  },
  {
    label: "The Office S1E1",
    mediaType: "tv",
    tmdbId: 2316,
    season: 1,
    episode: 1,
    categories: ["episode", "older", "long-running"],
    browser: true,
  },
  {
    label: "The Simpsons S1E1",
    mediaType: "tv",
    tmdbId: 456,
    season: 1,
    episode: 1,
    categories: ["episode", "older", "long-running"],
  },
  {
    label: "Supernatural S1E1",
    mediaType: "tv",
    tmdbId: 1622,
    season: 1,
    episode: 1,
    categories: ["episode", "older", "long-running"],
  },
  {
    label: "Attack on Titan S1E1",
    mediaType: "tv",
    tmdbId: 1429,
    season: 1,
    episode: 1,
    categories: ["episode", "anime", "historical-failure"],
    browser: true,
  },
  {
    label: "Frieren S1E1",
    mediaType: "tv",
    tmdbId: 209867,
    season: 1,
    episode: 1,
    categories: ["episode", "anime", "new-release"],
  },
  {
    label: "One Piece S1E1",
    mediaType: "tv",
    tmdbId: 37854,
    season: 1,
    episode: 1,
    categories: ["episode", "anime", "long-running", "historical-failure"],
  },
  {
    label: "Cowboy Bebop S1E1",
    mediaType: "tv",
    tmdbId: 30991,
    season: 1,
    episode: 1,
    categories: ["episode", "anime", "classic"],
  },
  {
    label: "Dark S1E1",
    mediaType: "tv",
    tmdbId: 70523,
    season: 1,
    episode: 1,
    categories: ["episode", "international"],
  },
  {
    label: "The Leftovers S1E1",
    mediaType: "tv",
    tmdbId: 54344,
    season: 1,
    episode: 1,
    categories: ["episode", "obscure"],
  },
  {
    label: "Detectorists S1E1",
    mediaType: "tv",
    tmdbId: 62788,
    season: 1,
    episode: 1,
    categories: ["episode", "obscure", "international"],
  },
];

const BASE = (process.env.CINEHOME_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const SCRAPER_BASE = (process.env.SCRAPER_URL || "http://127.0.0.1:3030").replace(/\/$/, "");
const STORAGE_STATE = process.env.STORAGE_STATE || "/tmp/cinehome-baseline-storage.json";
const OUT_DIR = process.env.OUT_DIR || "/tmp/cinehome-ownership-baseline";
const FIRST_FRAME_TIMEOUT_MS = envInt("FIRST_FRAME_TIMEOUT_MS", 45_000);
const STEADY_WATCH_MS = envInt("STEADY_WATCH_MS", 12_000);
const TITLE_LIMIT = envInt("TITLE_LIMIT", FIXTURES.length);
const PLAYBACK_LIMIT = envInt("PLAYBACK_LIMIT", 6);
const SCRAPER_COLD = envFlag("SCRAPER_COLD", true);
const WARM_REPEAT = envFlag("WARM_REPEAT", true);
const FAILOVER_SOURCE_TYPE = (process.env.FAILOVER_SOURCE_TYPE || "").trim().toLowerCase();
const FAILOVER_SOURCE_PROVIDER = (
  process.env.FAILOVER_SOURCE_PROVIDER || ""
).trim().toLowerCase();
const FAILOVER_SOURCE_ID_INCLUDES = (
  process.env.FAILOVER_SOURCE_ID_INCLUDES || ""
).trim().toLowerCase();
const TARGET_SOURCE_TYPE = (process.env.TARGET_SOURCE_TYPE || "").trim().toLowerCase();
const TARGET_SOURCE_PROVIDER = (
  process.env.TARGET_SOURCE_PROVIDER || ""
).trim().toLowerCase();
const TARGET_SOURCE_ID_INCLUDES = (
  process.env.TARGET_SOURCE_ID_INCLUDES || ""
).trim().toLowerCase();
const TARGET_RESELECT_ACTIVE = envFlag("TARGET_RESELECT_ACTIVE", false);
const SKIP_FAILOVER = envFlag("SKIP_FAILOVER", false);
const FIXTURE_FILTER = (process.env.FIXTURE_FILTER || "").trim().toLowerCase();

function selectedFixtures(): Fixture[] {
  if (!FIXTURE_FILTER) return FIXTURES;
  return FIXTURES.filter((fixture) =>
    fixture.label.toLowerCase().includes(FIXTURE_FILTER)
  );
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] || "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function queryFor(fixture: Fixture): string {
  const p = new URLSearchParams();
  if (fixture.mediaType === "tv") {
    p.set("season", String(fixture.season || 1));
    p.set("episode", String(fixture.episode || 1));
  }
  return p.toString();
}

function watchPath(fixture: Fixture): string {
  const query = queryFor(fixture);
  return `/watch/${fixture.mediaType}/${fixture.tmdbId}${query ? `?${query}` : ""}`;
}

function summarizeSource(source: Record<string, unknown>): SourceSummary {
  const probe = source.probe as Record<string, unknown> | undefined;
  return {
    id: String(source.id || ""),
    provider: String(source.provider || ""),
    label: String(source.label || ""),
    origin: source.origin === "debrid" ? "debrid" : source.origin === "embed" ? "embed" : null,
    quality: String(source.quality || ""),
    type: String(source.type || ""),
    maxHeight: typeof source.maxHeight === "number" ? source.maxHeight : null,
    ladder: Array.isArray(source.ladder)
      ? source.ladder.filter((v): v is number => typeof v === "number")
      : [],
    qualitySource: typeof source.qualitySource === "string" ? source.qualitySource : null,
    codec: typeof source.codec === "string" ? source.codec : null,
    container: typeof source.container === "string" ? source.container : null,
    compat: typeof source.compat === "string" ? source.compat : null,
    verified: typeof source.verified === "boolean" ? source.verified : null,
    probeOk: typeof probe?.ok === "boolean" ? probe.ok : null,
    probeTtfbMs: typeof probe?.ttfbMs === "number" ? probe.ttfbMs : null,
    probeBytesPerSec: typeof probe?.bytesPerSec === "number" ? probe.bytesPerSec : null,
    url: String(source.url || ""),
  };
}

function publicSource(source: SourceSummary): Omit<SourceSummary, "url"> {
  const { url: _redacted, ...safe } = source;
  return safe;
}

async function apiPlayback(
  page: Page,
  fixture: Fixture,
  fast: boolean
): Promise<ApiCall> {
  const p = new URLSearchParams(queryFor(fixture));
  if (fast) p.set("fast", "1");
  p.set("qualityHint", "1080");
  const started = performance.now();
  try {
    const result = await page.evaluate(
      async ({ url, timeoutMs }) => {
        const res = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          status: res.status,
          ok: res.ok,
          cache: res.headers.get("x-playback-cache"),
          body: await res.text(),
        };
      },
      {
        url: `${BASE}/api/playback/${fixture.mediaType}/${fixture.tmdbId}?${p.toString()}`,
        timeoutMs: fast ? 15_000 : 45_000,
      }
    );
    const ms = Math.round(performance.now() - started);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(result.body) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const rawSources = Array.isArray(body?.sources) ? body.sources : [];
    const sources = rawSources
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
      .map(summarizeSource);
    const streamUrl = typeof body?.streamUrl === "string" ? body.streamUrl : "";
    const defaultSource = sources.find((source) => source.url === streamUrl) ?? null;
    return {
      ok: result.ok && body?.status === "available" && sources.length > 0,
      status: result.status,
      ms,
      cache: result.cache,
      responseStatus: typeof body?.status === "string" ? body.status : null,
      partial: typeof body?.partial === "boolean" ? body.partial : null,
      sourceCount: sources.length,
      defaultSource: defaultSource ? publicSource(defaultSource) : null,
      sources: sources.map(publicSource),
      error:
        result.ok && body
          ? typeof body.message === "string"
            ? body.message
            : null
          : body
            ? `HTTP ${result.status}`
            : `HTTP ${result.status}: invalid JSON`,
      _sources: sources,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - started),
      cache: null,
      responseStatus: null,
      partial: null,
      sourceCount: 0,
      defaultSource: null,
      sources: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function coldScraperFast(fixture: Fixture): Promise<Record<string, unknown> | null> {
  if (!SCRAPER_COLD) return null;
  const p = new URLSearchParams({
    tmdbId: String(fixture.tmdbId),
    mediaType: fixture.mediaType,
    fast: "1",
    nocache: "1",
  });
  if (fixture.mediaType === "tv") {
    p.set("season", String(fixture.season || 1));
    p.set("episode", String(fixture.episode || 1));
  }
  const started = performance.now();
  try {
    const res = await fetch(`${SCRAPER_BASE}/scrape?${p.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const sources = Array.isArray(body.sources)
      ? body.sources.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
      : [];
    const healthRes = await fetch(`${SCRAPER_BASE}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const health = (await healthRes.json()) as Record<string, unknown>;
    const lastScrape =
      health.lastScrape && typeof health.lastScrape === "object"
        ? (health.lastScrape as Record<string, unknown>)
        : null;
    return {
      ok: res.ok && sources.length > 0,
      status: res.status,
      ms: Math.round(performance.now() - started),
      sourceCount: sources.length,
      providers: [...new Set(sources.map((s) => String(s.provider || "(unknown)")))],
      labels: [...new Set(sources.map((s) => String(s.label || "(unknown)")))],
      partial: typeof body.partial === "boolean" ? body.partial : null,
      error: typeof body.error === "string" ? body.error : null,
      providerTimings: Array.isArray(lastScrape?.providers)
        ? lastScrape.providers
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - started),
      sourceCount: 0,
      providers: [],
      labels: [],
      partial: null,
      error: error instanceof Error ? error.message : String(error),
      providerTimings: null,
    };
  }
}

async function resolutionMatrix(context: BrowserContext): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const fixtures = selectedFixtures().slice(0, TITLE_LIMIT);
    for (const [index, fixture] of fixtures.entries()) {
      console.log(`[resolution ${index + 1}/${fixtures.length}] ${fixture.label}`);
      const [fast, full] = await Promise.all([
        apiPlayback(page, fixture, true),
        apiPlayback(page, fixture, false),
      ]);
      const scraperCold = await coldScraperFast(fixture);
      results.push({
        fixture,
        apiFast: stripPrivate(fast),
        apiFull: stripPrivate(full),
        scraperColdFast: scraperCold,
        resolved: fast.ok || full.ok,
        hasDebrid: [...(fast.sources || []), ...(full.sources || [])].some(
          (source) => source.origin === "debrid"
        ),
      });
    }
  } finally {
    await page.close();
  }
  return results;
}

function stripPrivate(call: ApiCall): Omit<ApiCall, "_sources"> {
  const { _sources: _discard, ...safe } = call;
  return safe;
}

function classifyResponse(response: Response): string | null {
  const url = response.url();
  if (url.includes("/api/playback/")) return url.includes("fast=1") ? "playback_fast" : "playback_full";
  if (url.includes("/api/hls/")) {
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("dash+xml")) return "manifest";
    if (ct.includes("video") || ct.includes("octet-stream") || ct.includes("mp2t")) return "media";
    return "hls_other";
  }
  if (url.includes("/api/transcode")) return "transcode";
  return null;
}

function safeProxyTarget(responseUrl: string): {
  upstreamHost: string | null;
  upstreamPathKind: string | null;
} {
  try {
    const encoded = new URL(responseUrl).searchParams.get("u");
    if (!encoded) return { upstreamHost: null, upstreamPathKind: null };
    const upstream = new URL(Buffer.from(encoded, "base64url").toString("utf8"));
    const path = upstream.pathname.toLowerCase();
    const upstreamPathKind =
      path.includes(".mpd")
        ? "mpd"
        : path.includes(".m3u8")
          ? "m3u8"
          : path.includes(".m4s")
            ? "m4s"
            : path.includes(".mp4")
              ? "mp4"
              : path.includes(".ts")
                ? "ts"
                : "other";
    return { upstreamHost: upstream.hostname, upstreamPathKind };
  } catch {
    return { upstreamHost: null, upstreamPathKind: null };
  }
}

async function readBrowserState(page: Page, started: number): Promise<BrowserState | null> {
  return page.evaluate(
    ({ baselineStart }) => {
      const video = document.querySelector("video") as HTMLVideoElement | null;
      if (!video) return null;
      let bufferedAhead = 0;
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
          bufferedAhead = Math.max(0, video.buffered.end(i) - video.currentTime);
          break;
        }
      }
      return {
        atMs: Date.now() - baselineStart,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        seeking: video.seeking,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        bufferedAhead,
        src: video.currentSrc || video.src || "",
        mediaError: video.error?.code ?? null,
      };
    },
    { baselineStart: started }
  );
}

function firstFrameReady(state: BrowserState | null): boolean {
  return Boolean(
    state &&
      state.videoWidth > 0 &&
      state.videoHeight > 0 &&
      state.currentTime > 0.1 &&
      state.readyState >= 2 &&
      !state.paused
  );
}

function sessionId(url: string): string | null {
  const match = url.match(/\/api\/hls\/([^?/#]+)/);
  return match?.[1] || null;
}

function findAttachedSource(
  state: BrowserState | null,
  calls: ApiCall[],
  observedSession?: string | null,
  activeServerName?: string | null
): Omit<SourceSummary, "url"> | null {
  if (activeServerName) {
    for (const call of calls) {
      const source = call._sources?.find(
        (candidate) =>
          getServerDisplayName(candidate.provider, candidate.label, candidate.id) ===
          activeServerName
      );
      if (source) return publicSource(source);
    }
  }
  if (state?.src) {
    for (const call of calls) {
      const source = call._sources?.find((candidate) => candidate.url === state.src);
      if (source) return publicSource(source);
    }
  }
  // hls.js attaches a blob: MediaSource to <video>, so currentSrc no longer
  // contains the proxy session. The actual /api/hls request stream is the
  // authoritative attached-session signal in that case.
  const sid = observedSession || sessionId(state?.src || "");
  if (!sid) return null;
  for (const call of calls) {
    const source = call._sources?.find((candidate) => sessionId(candidate.url) === sid);
    if (source) return publicSource(source);
  }
  return null;
}

async function readActiveServerName(page: Page): Promise<string | null> {
  await page.mouse.move(100, 100);
  const open = page.locator('button[title="Servers"]').first();
  if ((await open.count()) === 0) return null;
  await open.click({ timeout: 3_000 }).catch(() => {});
  const dialog = page.locator('[role="dialog"][aria-label="Servers"]');
  const live = dialog.locator("button").filter({ hasText: "Live" }).first();
  const name = (await live.getAttribute("aria-label").catch(() => null))?.replace(
    /\s+—.*$/,
    ""
  ) ?? null;
  await dialog.locator('button[aria-label="Close servers"]').click().catch(() => {});
  return name;
}

async function seekProbe(page: Page, started: number): Promise<Record<string, unknown>> {
  const before = await readBrowserState(page, started);
  if (!before?.duration || before.duration < 120) {
    return { attempted: false, reason: "duration unavailable or too short" };
  }
  const target = Math.min(before.duration * 0.55, before.currentTime + 600);
  const wallStart = Date.now();
  await page.evaluate((seekTarget) => {
    const video = document.querySelector("video") as HTMLVideoElement | null;
    if (!video) return;
    video.currentTime = seekTarget;
    void video.play().catch(() => {});
  }, target);
  let recovered: BrowserState | null = null;
  while (Date.now() - wallStart < 30_000) {
    const state = await readBrowserState(page, started);
    if (
      state &&
      !state.seeking &&
      state.readyState >= 2 &&
      state.currentTime >= target - 1 &&
      !state.paused
    ) {
      recovered = state;
      break;
    }
    await page.waitForTimeout(250);
  }
  return {
    attempted: true,
    target: Math.round(target * 100) / 100,
    recovered: Boolean(recovered),
    latencyMs: recovered ? Date.now() - wallStart : null,
    final: recovered ? publicBrowserState(recovered) : publicBrowserState(await readBrowserState(page, started)),
  };
}

async function forcedFailoverProbe(
  page: Page,
  started: number,
  calls: ApiCall[],
  activeServerName: string | null,
  getActiveSession: () => string | null,
  getRecoverySession: (sinceMs: number, excludeSession: string) => string | null,
  desiredSourceType = ""
): Promise<Record<string, unknown>> {
  const forcedSelection = desiredSourceType
    ? await selectRosterSource(
        page,
        started,
        calls,
        desiredSourceType,
        FAILOVER_SOURCE_PROVIDER,
        FAILOVER_SOURCE_ID_INCLUDES
      )
    : null;
  if (
    desiredSourceType &&
    forcedSelection &&
    forcedSelection.selected !== true
  ) {
    return {
      attempted: false,
      reason: `no healthy ${desiredSourceType} source available for injection`,
      forcedSelection,
    };
  }
  const currentServerName =
    (await readActiveServerName(page).catch(() => null)) || activeServerName;
  const before = await readBrowserState(page, started);
  const namedSource = currentServerName
    ? calls
        .flatMap((call) => call._sources || [])
        .find(
          (source) =>
            getServerDisplayName(source.provider, source.label, source.id) ===
            currentServerName
        )
    : null;
  // Progressive MP4 may satisfy selection from one range request while an old
  // HLS session remains the most recently chatty network session. Source
  // identity is authoritative; network recency is only a fallback.
  const failedSession =
    sessionId(namedSource?.url || "") ||
    getActiveSession() ||
    sessionId(before?.src || "");
  const failedDirectUrl = namedSource?.url || null;
  if (
    !before ||
    (!failedSession && !failedDirectUrl) ||
    !before.duration ||
    before.duration < 180
  ) {
    return {
      attempted: false,
      reason: "active media source or duration unavailable",
      forcedSelection,
    };
  }
  const beforeSource = findAttachedSource(
    before,
    calls,
    failedSession,
    currentServerName
  );
  let injectedFailures = 0;
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (
      (failedSession && requestUrl.includes(`/api/hls/${failedSession}`)) ||
      (failedDirectUrl && requestUrl === failedDirectUrl)
    ) {
      injectedFailures += 1;
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "ownership-baseline injected source failure",
      });
      return;
    }
    await route.continue();
  });
  const target = Math.min(before.duration * 0.8, before.currentTime + 1_200);
  const wallStart = Date.now();
  await page.evaluate((seekTarget) => {
    const video = document.querySelector("video") as HTMLVideoElement | null;
    if (!video) return;
    video.currentTime = seekTarget;
    void video.play().catch(() => {});
  }, target);
  let recovered: BrowserState | null = null;
  let recoveredServerName: string | null = null;
  let recoveredSession: string | null = null;
  let nextUiCheckAt = 0;
  while (Date.now() - wallStart < 40_000) {
    const state = await readBrowserState(page, started);
    const changedSession =
      getRecoverySession(wallStart, failedSession || "") || sessionId(state?.src || "");
    if (Date.now() >= nextUiCheckAt) {
      nextUiCheckAt = Date.now() + 1_000;
      const candidateName = await readActiveServerName(page).catch(() => null);
      if (candidateName && candidateName !== currentServerName) {
        recoveredServerName = candidateName;
      }
    }
    if (
      state &&
      injectedFailures > 0 &&
      ((changedSession && changedSession !== failedSession) || recoveredServerName) &&
      state.readyState >= 2 &&
      !state.paused &&
      state.currentTime > 0.1
    ) {
      const t = state.currentTime;
      await page.waitForTimeout(1_000);
      const advanced = await readBrowserState(page, started);
      if (advanced && advanced.currentTime > t + 0.3) {
        recovered = advanced;
        recoveredSession = changedSession;
        break;
      }
    }
    await page.waitForTimeout(250);
  }
  await page.unroute("**/*");
  return {
    attempted: true,
    injectedFailures,
    recovered: Boolean(recovered),
    recoveryMs: recovered ? Date.now() - wallStart : null,
    beforeSource,
    beforeServerName: currentServerName,
    forcedSelection,
    afterServerName: recoveredServerName,
    afterSource: findAttachedSource(recovered, calls, recoveredSession, recoveredServerName),
    final: publicBrowserState(recovered ?? (await readBrowserState(page, started))),
  };
}

async function selectRosterSource(
  page: Page,
  started: number,
  calls: ApiCall[],
  desiredSourceType: string,
  desiredProvider = "",
  desiredIdIncludes = "",
  reselectActive = false
): Promise<Record<string, unknown>> {
  const byId = new Map<string, SourceSummary>();
  for (const source of calls.flatMap((call) => call._sources || [])) {
    if (source.type.toLowerCase() !== desiredSourceType) continue;
    if (
      desiredProvider &&
      !source.provider.toLowerCase().includes(desiredProvider)
    ) {
      continue;
    }
    if (desiredIdIncludes && !source.id.toLowerCase().includes(desiredIdIncludes)) {
      continue;
    }
    const current = byId.get(source.id);
    // A measured result, including a measured failure, is more authoritative
    // than the same source's earlier fast-path "unknown" entry.
    if (!current || (current.probeOk == null && source.probeOk != null)) {
      byId.set(source.id, source);
    }
  }
  const candidates = [...byId.values()].filter(
    (source) => source.probeOk !== false
  );
  const source = candidates[0];
  if (!source) {
    return {
      requestedType: desiredSourceType,
      requestedProvider: desiredProvider || null,
      requestedIdIncludes: desiredIdIncludes || null,
      selected: false,
      reason: "no matching source in playback roster",
    };
  }

  const serverName = getServerDisplayName(
    source.provider,
    source.label,
    source.id
  );
  await page.mouse.move(100, 100);
  const open = page.locator('button[title="Servers"]').first();
  if ((await open.count()) === 0) {
    return {
      requestedType: desiredSourceType,
      requestedProvider: desiredProvider || null,
      requestedIdIncludes: desiredIdIncludes || null,
      selected: false,
      source: publicSource(source),
      serverName,
      reason: "Servers control unavailable",
    };
  }
  await open.click({ timeout: 3_000 }).catch(async () => {
    await open.evaluate((button: HTMLButtonElement) => button.click()).catch(() => {});
  });
  const dialog = page.locator('[role="dialog"][aria-label="Servers"]');
  await dialog.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  let target = dialog.locator(`button[data-source-id="${source.id}"]`);
  if ((await target.count()) === 0) {
    await dialog
      .getByRole("button", { name: /Show \d+ more servers?/i })
      .click()
      .catch(() => {});
    target = dialog.locator(`button[data-source-id="${source.id}"]`);
  }
  if ((await target.count()) === 0) {
    await dialog.locator('button[aria-label="Close servers"]').click().catch(() => {});
    return {
      requestedType: desiredSourceType,
      requestedProvider: desiredProvider || null,
      requestedIdIncludes: desiredIdIncludes || null,
      selected: false,
      source: publicSource(source),
      serverName,
      reason: "matching server row unavailable",
    };
  }

  if (!reselectActive && (await target.textContent())?.includes("Live")) {
    const first = await readBrowserState(page, started);
    await page.waitForTimeout(500);
    const second = await readBrowserState(page, started);
    if (
      first &&
      second &&
      second.readyState >= 2 &&
      !second.paused &&
      second.currentTime > first.currentTime + 0.2
    ) {
      await dialog.locator('button[aria-label="Close servers"]').click().catch(() => {});
      return {
        requestedType: desiredSourceType,
        requestedProvider: desiredProvider || null,
        requestedIdIncludes: desiredIdIncludes || null,
        selected: true,
        alreadyActive: true,
        source: publicSource(source),
        serverName,
        readyMs: 0,
      };
    }
  }

  if (await target.isDisabled()) {
    await dialog.locator('button[aria-label="Close servers"]').click().catch(() => {});
    return {
      requestedType: desiredSourceType,
      requestedProvider: desiredProvider || null,
      requestedIdIncludes: desiredIdIncludes || null,
      selected: false,
      source: publicSource(source),
      serverName,
      reason: "matching server row is unavailable in this browser",
    };
  }

  const wallStart = Date.now();
  await target.click();
  let firstHealthy: BrowserState | null = null;
  while (Date.now() - wallStart < 30_000) {
    const state = await readBrowserState(page, started);
    const activeName = await readActiveServerName(page).catch(() => null);
    if (
      state &&
      activeName === serverName &&
      state.readyState >= 2 &&
      !state.paused &&
      state.videoWidth > 0
    ) {
      if (firstHealthy && state.currentTime > firstHealthy.currentTime + 0.3) {
        return {
          requestedType: desiredSourceType,
          requestedProvider: desiredProvider || null,
          requestedIdIncludes: desiredIdIncludes || null,
          selected: true,
          source: publicSource(source),
          serverName,
          readyMs: Date.now() - wallStart,
        };
      }
      firstHealthy = state;
    }
    await page.waitForTimeout(500);
  }
  return {
    requestedType: desiredSourceType,
    requestedProvider: desiredProvider || null,
    requestedIdIncludes: desiredIdIncludes || null,
    selected: false,
    source: publicSource(source),
    serverName,
    reason: "selected source did not become healthy",
    readyMs: Date.now() - wallStart,
  };
}

function publicBrowserState(state: BrowserState | null): Omit<BrowserState, "src"> | null {
  if (!state) return null;
  const { src: _redacted, ...safe } = state;
  return safe;
}

async function playbackScenario(
  context: BrowserContext,
  fixture: Fixture,
  temperature: "cold" | "warm"
): Promise<Record<string, unknown>> {
  const page = await context.newPage();
  const started = Date.now();
  const network: Array<Record<string, unknown>> = [];
  const apiCalls: ApiCall[] = [];
  const hlsSessions: string[] = [];
  const hlsSessionStats = new Map<
    string,
    {
      count: number;
      mediaCount: number;
      lastAt: number;
      lastMediaAt: number;
      lastMediaStatus: number;
    }
  >();
  const cdpProperties: Record<string, string> = {};
  const cdpMessages: string[] = [];
  const playbackFailures: string[] = [];

  page.on("console", (message) => {
    const text = message.text();
    if (
      text.startsWith("[playback-failure]") &&
      playbackFailures.length < 30
    ) {
      playbackFailures.push(text.slice(0, 1_000));
    }
  });

  await page.addInitScript(() => {
    const events = [
      "loadstart",
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "playing",
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "emptied",
      "ended",
      "error",
    ];
    const metrics = { events: [] as Array<Record<string, unknown>> };
    Object.defineProperty(window, "__cineOwnershipMetrics", {
      value: metrics,
      configurable: true,
    });
    const attach = (video: HTMLVideoElement) => {
      if (video.dataset.ownershipMetrics === "1") return;
      video.dataset.ownershipMetrics = "1";
      for (const name of events) {
        video.addEventListener(name, () => {
          metrics.events.push({
            name,
            at: Date.now(),
            currentTime: video.currentTime,
            readyState: video.readyState,
            width: video.videoWidth,
            height: video.videoHeight,
            error: video.error?.code ?? null,
          });
        });
      }
    };
    const observer = new MutationObserver(() => {
      document.querySelectorAll("video").forEach((node) => attach(node as HTMLVideoElement));
    });
    const start = () => {
      document.querySelectorAll("video").forEach((node) => attach(node as HTMLVideoElement));
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Media.enable").catch(() => {});
  cdp.on("Media.playerPropertiesChanged", (event: { properties?: Array<{ name: string; value: string }> }) => {
    for (const property of event.properties || []) {
      cdpProperties[property.name] = property.value;
    }
  });
  cdp.on("Media.playerMessagesLogged", (event: { messages?: Array<{ message: string }> }) => {
    for (const message of event.messages || []) {
      if (cdpMessages.length < 40) cdpMessages.push(message.message);
    }
  });

  page.on("response", async (response) => {
    const kind = classifyResponse(response);
    if (!kind) return;
    const observedSession = sessionId(response.url());
    if (
      observedSession &&
      (kind === "manifest" || kind === "media" || kind === "hls_other") &&
      hlsSessions.at(-1) !== observedSession
    ) {
      hlsSessions.push(observedSession);
    }
    if (observedSession && (kind === "manifest" || kind === "media" || kind === "hls_other")) {
      const previous = hlsSessionStats.get(observedSession) || {
        count: 0,
        mediaCount: 0,
        lastAt: 0,
        lastMediaAt: 0,
        lastMediaStatus: 0,
      };
      const now = Date.now();
      previous.count += 1;
      previous.lastAt = now;
      if (kind === "media") {
        previous.mediaCount += 1;
        previous.lastMediaAt = now;
        previous.lastMediaStatus = response.status();
      }
      hlsSessionStats.set(observedSession, previous);
    }
    const safeTarget = safeProxyTarget(response.url());
    network.push({
      atMs: Date.now() - started,
      kind,
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
      contentLength: Number(response.headers()["content-length"] || "") || null,
      ...safeTarget,
    });
    if (kind === "playback_fast" || kind === "playback_full") {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        const rawSources = Array.isArray(body.sources) ? body.sources : [];
        const sources = rawSources
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .map(summarizeSource);
        const streamUrl = typeof body.streamUrl === "string" ? body.streamUrl : "";
        const defaultSource = sources.find((source) => source.url === streamUrl) ?? null;
        apiCalls.push({
          ok: response.ok() && body.status === "available" && sources.length > 0,
          status: response.status(),
          ms: 0,
          cache: response.headers()["x-playback-cache"] || null,
          responseStatus: typeof body.status === "string" ? body.status : null,
          partial: typeof body.partial === "boolean" ? body.partial : null,
          sourceCount: sources.length,
          defaultSource: defaultSource ? publicSource(defaultSource) : null,
          sources: sources.map(publicSource),
          error: typeof body.message === "string" ? body.message : null,
          _sources: sources,
        });
      } catch {
        // A failed/aborted response remains represented in network[].
      }
    }
  });

  let firstFrame: BrowserState | null = null;
  const samples: BrowserState[] = [];
  let navigationError: string | null = null;
  try {
    await page.goto(`${BASE}${watchPath(fixture)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const wallStart = Date.now();
    let clicked = false;
    while (Date.now() - wallStart < FIRST_FRAME_TIMEOUT_MS) {
      const state = await readBrowserState(page, started);
      if (state) samples.push(state);
      if (firstFrameReady(state)) {
        firstFrame = state;
        break;
      }
      if (!clicked && Date.now() - wallStart > 4_000) {
        clicked = true;
        await page.locator("video").click({ force: true }).catch(() => {});
        await page
          .evaluate(() => {
            const video = document.querySelector("video") as HTMLVideoElement | null;
            return video?.play().catch(() => {});
          })
          .catch(() => {});
      }
      await page.waitForTimeout(250);
    }
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  const activeMediaSession = (): string | null => {
    const ranked = [...hlsSessionStats.entries()]
      .filter(([, stats]) => stats.mediaCount > 0 && stats.lastMediaStatus >= 200 && stats.lastMediaStatus < 400)
      .sort(
        (a, b) =>
          b[1].lastMediaAt - a[1].lastMediaAt ||
          b[1].mediaCount - a[1].mediaCount ||
          b[1].count - a[1].count
      );
    return ranked[0]?.[0] || null;
  };
  const recoveryMediaSession = (sinceMs: number, excludeSession: string): string | null => {
    const ranked = [...hlsSessionStats.entries()]
      .filter(
        ([sid, stats]) =>
          sid !== excludeSession &&
          stats.lastMediaAt >= sinceMs &&
          stats.lastMediaStatus >= 200 &&
          stats.lastMediaStatus < 400
      )
      .sort((a, b) => b[1].lastMediaAt - a[1].lastMediaAt);
    return ranked[0]?.[0] || null;
  };
  const firstPlaybackSession = activeMediaSession();
  const firstActiveServerName = firstFrame
    ? await readActiveServerName(page).catch(() => null)
    : null;
  const steadyStarted = Date.now();
  while (firstFrame && Date.now() - steadyStarted < STEADY_WATCH_MS) {
    const state = await readBrowserState(page, started);
    if (state) samples.push(state);
    await page.waitForTimeout(500);
  }
  const steadyFinalState = await readBrowserState(page, started);
  const steadyPlaybackSession = activeMediaSession();

  const eventMetrics = await page
    .evaluate(() => {
      const metrics = (
        window as typeof window & {
          __cineOwnershipMetrics?: { events?: Array<Record<string, unknown>> };
        }
      ).__cineOwnershipMetrics;
      return metrics?.events || [];
    })
    .catch(() => [] as Array<Record<string, unknown>>);
  const postFrameEvents = firstFrame
    ? eventMetrics.filter((event) => Number(event.at || 0) >= started + firstFrame!.atMs)
    : [];
  const waitingEvents = postFrameEvents.filter(
    (event) => event.name === "waiting" || event.name === "stalled"
  );
  const steadyActiveServerName = firstFrame
    ? await readActiveServerName(page).catch(() => null)
    : null;
  const distinctSessions = [...new Set(hlsSessions)];
  const attached = findAttachedSource(
    firstFrame ?? samples.at(-1) ?? null,
    apiCalls,
    firstPlaybackSession || steadyPlaybackSession,
    firstActiveServerName || steadyActiveServerName
  );
  const firstDefault =
    (attached
      ? apiCalls.find((call) => call._sources?.some((source) => source.id === attached.id))
          ?.defaultSource
      : null) ??
    apiCalls.find((call) => call.defaultSource)?.defaultSource ??
    null;

  const targetSelection =
    firstFrame && TARGET_SOURCE_TYPE
      ? await selectRosterSource(
          page,
          started,
          apiCalls,
          TARGET_SOURCE_TYPE,
          TARGET_SOURCE_PROVIDER,
          TARGET_SOURCE_ID_INCLUDES,
          TARGET_RESELECT_ACTIVE
        )
      : null;
  const targetReady =
    !TARGET_SOURCE_TYPE || targetSelection?.selected === true;
  const seek =
    firstFrame && fixture.seek && targetReady
      ? await seekProbe(page, started)
      : targetSelection
        ? {
            attempted: false,
            reason: "requested target source did not become healthy",
          }
        : null;
  const failover =
    !SKIP_FAILOVER &&
    firstFrame &&
    targetReady &&
    (fixture.failover || Boolean(FAILOVER_SOURCE_TYPE))
      ? await forcedFailoverProbe(
          page,
          started,
          apiCalls,
          (await readActiveServerName(page).catch(() => null)) ||
            steadyActiveServerName ||
            firstActiveServerName,
          activeMediaSession,
          recoveryMediaSession,
          FAILOVER_SOURCE_TYPE
        )
      : null;
  const finalEventMetrics = await page
    .evaluate(() => {
      const metrics = (
        window as typeof window & {
          __cineOwnershipMetrics?: { events?: Array<Record<string, unknown>> };
        }
      ).__cineOwnershipMetrics;
      return metrics?.events || [];
    })
    .catch(() => [] as Array<Record<string, unknown>>);
  const finalState = await readBrowserState(page, started);
  const body = await page.locator("body").innerText().catch(() => "");
  const safeApiCalls = apiCalls.map(stripPrivate);
  await page.close();

  return {
    fixture,
    temperature,
    success: Boolean(firstFrame),
    firstFrameMs: firstFrame?.atMs ?? null,
    firstFrame: publicBrowserState(firstFrame),
    attachedSource: attached,
    advertisedDefault: firstDefault,
    topRankedActuallyPlayed:
      attached && firstDefault ? attached.id === firstDefault.id : null,
    activeServerAtFirstFrame: firstActiveServerName,
    activeServerAfterSteadyWatch: steadyActiveServerName,
    distinctActiveServerCount: new Set(
      [
        attached?.id,
        findAttachedSource(steadyFinalState, apiCalls, steadyPlaybackSession, steadyActiveServerName)?.id,
      ].filter(Boolean)
    ).size,
    observedHlsSessionCount: distinctSessions.length,
    waitingOrStalledEvents: waitingEvents.length,
    steadyAdvanceSeconds:
      firstFrame && steadyFinalState
        ? Math.round((steadyFinalState.currentTime - firstFrame.currentTime) * 100) / 100
        : null,
    finalState: publicBrowserState(finalState),
    apiCalls: safeApiCalls,
    networkSummary: summarizeNetwork(network),
    decoderProperties: cdpProperties,
    mediaMessages: cdpMessages,
    playbackFailures,
    mediaEvents: finalEventMetrics.slice(-50),
    targetSelection,
    seek,
    forcedFailover: failover,
    navigationError,
    errorUi: /all sources failed|no stream|playback failed|retry full/i.test(body)
      ? body.replace(/\s+/g, " ").slice(0, 300)
      : null,
  };
}

function summarizeNetwork(network: Array<Record<string, unknown>>): Record<string, unknown> {
  const byKind: Record<string, { count: number; ok: number; fourxx: number; fivexx: number }> = {};
  for (const item of network) {
    const kind = String(item.kind || "unknown");
    const status = Number(item.status || 0);
    byKind[kind] ||= { count: 0, ok: 0, fourxx: 0, fivexx: 0 };
    byKind[kind].count += 1;
    if (status >= 200 && status < 400) byKind[kind].ok += 1;
    else if (status >= 400 && status < 500) byKind[kind].fourxx += 1;
    else if (status >= 500) byKind[kind].fivexx += 1;
  }
  return { byKind, responses: network };
}

async function playbackMatrix(context: BrowserContext): Promise<Array<Record<string, unknown>>> {
  const fixtures = selectedFixtures()
    .filter((fixture) => fixture.browser)
    .slice(0, PLAYBACK_LIMIT);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, fixture] of fixtures.entries()) {
    console.log(`[playback ${index + 1}/${fixtures.length}] cold ${fixture.label}`);
    results.push(await playbackScenario(context, fixture, "cold"));
    if (fixture.warmRepeat && WARM_REPEAT) {
      console.log(`[playback ${index + 1}/${fixtures.length}] warm ${fixture.label}`);
      results.push(await playbackScenario(context, fixture, "warm"));
    }
  }
  return results;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function buildSummary(
  resolution: Array<Record<string, unknown>>,
  playback: Array<Record<string, unknown>>
): Record<string, unknown> {
  const resolved = resolution.filter((row) => row.resolved === true);
  const played = playback.filter((row) => row.success === true);
  const ttff = played
    .map((row) => Number(row.firstFrameMs))
    .filter((value) => Number.isFinite(value));
  const topRankKnown = playback.filter((row) => typeof row.topRankedActuallyPlayed === "boolean");
  return {
    resolution: {
      total: resolution.length,
      success: resolved.length,
      successRate: resolution.length ? resolved.length / resolution.length : null,
      withDebrid: resolution.filter((row) => row.hasDebrid === true).length,
    },
    playback: {
      total: playback.length,
      success: played.length,
      successRate: playback.length ? played.length / playback.length : null,
      ttffP50Ms: percentile(ttff, 0.5),
      ttffP95Ms: percentile(ttff, 0.95),
      topRankSample: topRankKnown.length,
      topRankPlayed: topRankKnown.filter((row) => row.topRankedActuallyPlayed === true).length,
      sourceSwitchRuns: playback.filter(
        (row) =>
          Number(row.distinctActiveServerCount) > 1 ||
          (row.forcedFailover as Record<string, unknown> | null)?.recovered ===
            true
      ).length,
      runsWithRebufferSignal: playback.filter((row) => Number(row.waitingOrStalledEvents) > 0).length,
    },
  };
}

async function main(): Promise<void> {
  const phase = (process.argv[2] || "all") as Phase;
  if (!["resolution", "playback", "all"].includes(phase)) {
    throw new Error(`Unknown phase "${phase}"`);
  }
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(`Missing STORAGE_STATE at ${STORAGE_STATE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    // Required for deterministic network timing/fault injection: Playwright
    // page routes cannot intercept requests owned by an active service worker.
    serviceWorkers: "block",
  });
  try {
    // The stored QA session is normally scoped to the Tailscale host. Inside
    // Docker that address cannot hairpin back to the app, so duplicate the
    // same cookies onto the loopback host in this isolated context only.
    const baseHost = new URL(BASE).hostname;
    const storedCookies = await context.cookies();
    const missingBaseScope = storedCookies.filter((cookie) => cookie.domain !== baseHost);
    if (missingBaseScope.length) {
      await context.addCookies(
        missingBaseScope.map((cookie) => ({
          ...cookie,
          domain: baseHost,
        }))
      );
    }
    const authPage = await context.newPage();
    await authPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const auth = await authPage.evaluate(async () => {
      const [sessionRes, protectedRes] = await Promise.all([
        fetch("/api/auth/session", { cache: "no-store" }),
        fetch("/api/progress", { cache: "no-store" }),
      ]);
      return {
        protectedOk: protectedRes.ok,
        session: (await sessionRes.json().catch(() => null)) as
          | { user?: { id?: string; isAdmin?: boolean } }
          | null,
      };
    });
    await authPage.close();
    if (!auth.session?.user?.id || !auth.protectedOk) {
      throw new Error("Stored browser session is not authenticated");
    }

    const startedAt = new Date().toISOString();
    const resolution = phase === "playback" ? [] : await resolutionMatrix(context);
    const playback = phase === "resolution" ? [] : await playbackMatrix(context);
    const report = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      phase,
      base: BASE,
      authenticated: true,
      testUserIsAdmin: Boolean(auth.session.user.isAdmin),
      config: {
        titleLimit: TITLE_LIMIT,
        playbackLimit: PLAYBACK_LIMIT,
        scraperCold: SCRAPER_COLD,
        warmRepeat: WARM_REPEAT,
        failoverSourceType: FAILOVER_SOURCE_TYPE || null,
        failoverSourceProvider: FAILOVER_SOURCE_PROVIDER || null,
        failoverSourceIdIncludes: FAILOVER_SOURCE_ID_INCLUDES || null,
        targetSourceType: TARGET_SOURCE_TYPE || null,
        targetSourceProvider: TARGET_SOURCE_PROVIDER || null,
        targetSourceIdIncludes: TARGET_SOURCE_ID_INCLUDES || null,
        targetReselectActive: TARGET_RESELECT_ACTIVE,
        skipFailover: SKIP_FAILOVER,
        fixtureFilter: FIXTURE_FILTER || null,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
        steadyWatchMs: STEADY_WATCH_MS,
      },
      summary: buildSummary(resolution, playback),
      resolution,
      playback,
    };
    const stamp = startedAt.replace(/[:.]/g, "-");
    const output = join(OUT_DIR, `baseline-${phase}-${stamp}.json`);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`REPORT ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
