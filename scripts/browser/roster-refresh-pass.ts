#!/usr/bin/env bun
/**
 * Release gate for exhausted-roster recovery.
 *
 * The first generation of media requests is forced to HTTP 428. The player
 * must issue one authenticated `refresh=1` playback request, receive a
 * refreshNonce, adopt that fresh roster, and reach an advancing real frame.
 */
import {
  chromium,
  type BrowserContext,
  type Route,
} from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.CINEHOME_BASE_URL || "http://127.0.0.1:4447").replace(
  /\/$/,
  ""
);
const WATCH_PATH =
  process.env.ROSTER_REFRESH_WATCH_PATH ||
  "/watch/tv/1429?season=1&episode=1";
const STORAGE_STATE =
  process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";
const OUT_DIR =
  process.env.ROSTER_REFRESH_OUT_DIR ||
  "/app/.browser-qa/roster-refresh-pass";
const MAX_RECOVERY_LATENCY_MS = Number(
  process.env.ROSTER_REFRESH_MAX_LATENCY_MS || 45_000
);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, ...(detail ? { detail } : {}) });
  console.log(`CHECK ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function ensureBaseCookieScope(context: BrowserContext): Promise<void> {
  const baseHost = new URL(BASE).hostname;
  const cookies = await context.cookies();
  const clones = cookies
    .filter((cookie) => cookie.domain !== baseHost)
    .map((cookie) => ({ ...cookie, domain: baseHost }));
  if (clones.length) await context.addCookies(clones);
}

function isMediaRequest(route: Route): boolean {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/hls/")) return true;
  if (request.resourceType() === "media") return true;
  return /\.(?:m3u8|mpd|mp4|m4s|ts)(?:$|\?)/i.test(request.url());
}

function isForbiddenReleaseStatus(status: number): boolean {
  return (
    status === 403 ||
    status === 428 ||
    status === 429 ||
    status >= 500
  );
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(`Storage state not found: ${STORAGE_STATE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    serviceWorkers: "block",
  });
  await ensureBaseCookieScope(context);

  let refreshRequests = 0;
  let refreshStatus: number | null = null;
  let refreshNonce: number | null = null;
  let refreshCompleted = false;
  let injectedFailures = 0;
  let allowedMediaRequests = 0;
  let refreshSourceCount = 0;
  let refreshDefaultSourceId: string | null = null;
  let firstInjectedFailureAt: number | null = null;
  let recoveryLatencyMs: number | null = null;
  const playerFailures: string[] = [];
  const playerFailureRecords: Array<{
    sourceId: string;
    generation: number;
    reason: string;
  }> = [];
  const initialSourceIds = new Set<string>();
  const postRefreshMediaStatuses: number[] = [];
  const playbackResponses: Array<{
    elapsedMs: number;
    refresh: boolean;
    status: number;
    cache: string | null;
    partial: boolean;
    sourceIds: string[];
  }> = [];
  const startedAt = Date.now();

  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      requestUrl.pathname.includes("/api/playback/") &&
      requestUrl.searchParams.get("refresh") === "1"
    ) {
      refreshRequests += 1;
      await route.continue();
      return;
    }
    if (!refreshCompleted && isMediaRequest(route)) {
      if (firstInjectedFailureAt == null) firstInjectedFailureAt = Date.now();
      injectedFailures += 1;
      await route.fulfill({
        status: 428,
        contentType: "text/plain",
        body: "roster-refresh release-gate injection",
      });
      return;
    }
    if (refreshCompleted && isMediaRequest(route)) allowedMediaRequests += 1;
    await route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("console", (message) => {
    const text = message.text();
    if (!text.includes("[playback-failure]")) return;
    playerFailures.push(text);
    const jsonStart = text.indexOf("{");
    if (jsonStart < 0) return;
    try {
      const payload = JSON.parse(text.slice(jsonStart)) as {
        sourceId?: unknown;
        generation?: unknown;
        reason?: unknown;
      };
      if (
        typeof payload.sourceId === "string" &&
        typeof payload.generation === "number" &&
        typeof payload.reason === "string"
      ) {
        playerFailureRecords.push({
          sourceId: payload.sourceId,
          generation: payload.generation,
          reason: payload.reason,
        });
      }
    } catch {
      // The raw console line remains in the report for diagnosis.
    }
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      !url.pathname.includes("/api/playback/") ||
      url.searchParams.get("refresh") !== "1"
    ) {
      return;
    }
    refreshStatus = response.status();
    // Release the injected media fault as soon as the fresh response headers
    // arrive. Waiting to parse its body races the app's own response handler
    // and can incorrectly poison the first source from the refreshed roster.
    refreshCompleted = response.ok();
    const payload = (await response.json().catch(() => null)) as {
      refreshNonce?: unknown;
      sources?: Array<{ id?: unknown }>;
      streamUrl?: unknown;
    } | null;
    if (typeof payload?.refreshNonce === "number") {
      refreshNonce = payload.refreshNonce;
    }
    refreshSourceCount = payload?.sources?.length ?? 0;
    const firstSourceId = payload?.sources?.find(
      (source) => typeof source.id === "string"
    )?.id;
    refreshDefaultSourceId =
      typeof firstSourceId === "string" ? firstSourceId : null;
  });
  page.on("response", (response) => {
    if (refreshCompleted && isMediaRequest({ request: () => response.request() } as Route)) {
      postRefreshMediaStatuses.push(response.status());
    }
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes("/api/playback/")) return;
    const payload = (await response.json().catch(() => null)) as {
      partial?: unknown;
      sources?: Array<{ id?: unknown }>;
    } | null;
    const sourceIds = (payload?.sources ?? [])
      .map((source) => source.id)
      .filter((id): id is string => typeof id === "string");
    if (!refreshCompleted && url.searchParams.get("refresh") !== "1") {
      for (const sourceId of sourceIds) initialSourceIds.add(sourceId);
    }
    playbackResponses.push({
      elapsedMs: Date.now() - startedAt,
      refresh: url.searchParams.get("refresh") === "1",
      status: response.status(),
      cache: response.headers()["x-playback-cache"] ?? null,
      partial: payload?.partial === true,
      sourceIds,
    });
  });

  let finalState: Record<string, unknown> | null = null;
  try {
    await page.goto(WATCH_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        const video = document.querySelector("video");
        if (!(video instanceof HTMLVideoElement)) return false;
        const previous = Number(video.dataset.refreshGateTime || "0");
        if (video.videoWidth > 0 && video.readyState >= 2 && video.currentTime > previous + 0.35) {
          return true;
        }
        video.dataset.refreshGateTime = String(video.currentTime);
        return false;
      },
      undefined,
      { timeout: 90_000, polling: 500 }
    );
    const state = await page.locator("video").evaluate((video: HTMLVideoElement) => ({
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      sourceId: video.dataset.playbackSourceId || null,
    }));
    finalState = state;
    recoveryLatencyMs =
      firstInjectedFailureAt == null
        ? null
        : Date.now() - firstInjectedFailureAt;
    const forbiddenPlaybackResponses = playbackResponses.filter((response) =>
      isForbiddenReleaseStatus(response.status)
    );
    const forbiddenPostRefreshMedia = postRefreshMediaStatuses.filter(
      isForbiddenReleaseStatus
    );
    const failedInitialIds = new Set(
      playerFailureRecords.map((failure) => failure.sourceId)
    );
    const everyInitialSourceFailed =
      initialSourceIds.size > 0 &&
      [...initialSourceIds].every((sourceId) =>
        failedInitialIds.has(sourceId)
      );
    const generationScopedFailures =
      playerFailureRecords.length >= initialSourceIds.size &&
      playerFailureRecords.every(
        (failure) =>
          Number.isInteger(failure.generation) && failure.generation > 0
      );

    check(
      "the initial roster was actually exhausted",
      injectedFailures >= initialSourceIds.size && everyInitialSourceFailed,
      `${injectedFailures} forced failure(s); initial=${[...initialSourceIds].join(",") || "none"}; ` +
        `failed=${[...failedInitialIds].join(",") || "none"}`
    );
    check("the player requested one bounded recovery roster", refreshRequests === 1, `${refreshRequests} refresh request(s)`);
    check("the recovery API returned a fresh generation", refreshStatus === 200 && refreshNonce != null, `HTTP ${refreshStatus}, nonce=${refreshNonce != null}`);
    check("fresh sources reached an advancing decoded frame", state.width > 0 && state.currentTime > 0, `${state.width}x${state.height} via ${state.sourceId}`);
    check(
      "recovery completes inside the release latency budget",
      recoveryLatencyMs != null &&
        recoveryLatencyMs <= MAX_RECOVERY_LATENCY_MS,
      `${recoveryLatencyMs ?? "unknown"}ms / ${MAX_RECOVERY_LATENCY_MS}ms`
    );
    check(
      "recovery playback avoids authorization, dead-source, rate-limit, and server errors",
      forbiddenPlaybackResponses.length === 0 &&
        forbiddenPostRefreshMedia.length === 0,
      [
        ...forbiddenPlaybackResponses.map(
          (response) =>
            `${response.status} ${response.refresh ? "refresh" : "playback"}@${response.elapsedMs}ms`
        ),
        ...forbiddenPostRefreshMedia.map(
          (status) => `${status} post-refresh-media`
        ),
      ].join(", ") || "none"
    );
    check(
      "the player surfaced generation-scoped failures during recovery",
      generationScopedFailures,
      `${playerFailureRecords.length}/${initialSourceIds.size} structured failure(s)`
    );
  } catch (error) {
    finalState = await page
      .evaluate(() => {
        const video = document.querySelector("video");
        return {
          video:
            video instanceof HTMLVideoElement
              ? {
                  width: video.videoWidth,
                  height: video.videoHeight,
                  currentTime: video.currentTime,
                  readyState: video.readyState,
                  paused: video.paused,
                  mediaError: video.error?.code ?? null,
                  sourceId: video.dataset.playbackSourceId || null,
                }
              : null,
          errorCards: Array.from(
            document.querySelectorAll('[role="alert"], [data-player-error]')
          )
            .map((node) => node.textContent?.trim())
            .filter(Boolean),
        };
      })
      .catch(() => null);
    check(
      "exhausted-roster recovery completed",
      false,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await context.close();
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    watchPath: WATCH_PATH,
    refreshRequests,
    refreshStatus,
    refreshNoncePresent: refreshNonce != null,
    refreshSourceCount,
    refreshDefaultSourceId,
    maxRecoveryLatencyMs: MAX_RECOVERY_LATENCY_MS,
    recoveryLatencyMs,
    injectedFailures,
    allowedMediaRequests,
    postRefreshMediaStatuses,
    playbackResponses,
    initialSourceIds: [...initialSourceIds],
    playerFailureCount: playerFailures.length,
    playerFailures: playerFailures.slice(-12),
    playerFailureRecords: playerFailureRecords.slice(-12),
    finalState,
    summary: {
      pass: checks.filter((item) => item.pass).length,
      fail: checks.filter((item) => !item.pass).length,
    },
    checks,
  };
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.fail > 0) process.exitCode = 1;
}

await main();
