#!/usr/bin/env bun
/**
 * Release gate for exhausted-roster recovery.
 *
 * The first generation of media requests is forced to HTTP 428 (exhaustion)
 * or 410 (signed-session expiry). The player must issue one authenticated
 * `refresh=1` request, adopt a fresh generation, and reach a real frame.
 */
import {
  chromium,
  type BrowserContext,
  type Page,
  type Request,
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
const FAILURE_STATUS = Number(process.env.ROSTER_FAILURE_STATUS || 428);
if (FAILURE_STATUS !== 410 && FAILURE_STATUS !== 428) {
  throw new Error("ROSTER_FAILURE_STATUS must be 410 or 428");
}
const SESSION_EXPIRY_MODE = FAILURE_STATUS === 410;
const SESSION_EXHAUSTION_MODE =
  SESSION_EXPIRY_MODE &&
  process.env.ROSTER_SESSION_EXHAUSTION === "1";

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
    status === 410 ||
    status === 428 ||
    status === 429 ||
    status >= 500
  );
}

async function showControls(page: Page): Promise<void> {
  const box = await page.locator("video").boundingBox();
  if (box) {
    await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + 20);
  }
  await page.waitForTimeout(150);
}

async function selectRealHlsSource(
  page: Page,
  beforeSelect: (sourceId: string) => void
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await showControls(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Player settings" });
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("tab", { name: "Sources", exact: true }).click();
    const ids = await dialog
      .locator("button[data-source-id]")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => button.getAttribute("data-source-id") || "")
          .filter(Boolean)
      );
    const target = ids.find((id) => /vidking|vixsrc/i.test(id));
    if (target) {
      beforeSelect(target);
      await dialog.locator(`button[data-source-id="${target}"]`).click();
      await page.keyboard.press("Escape");
      return target;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
  throw new Error("no real HLS source appeared for the session-expiry gate");
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
  let faultInjectionEnabled = !SESSION_EXPIRY_MODE;
  let sessionTargetSourceId: string | null = null;
  const prematureSessionSourceSwitches = new Set<string>();
  const injectedRequests = new WeakSet<Request>();
  const initialSourceById = new Map<
    string,
    Record<string, unknown> & { id: string; url?: unknown }
  >();
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

  const fulfillPlaybackResponse = async (
    route: Route,
    staleMode: "always" | "after-refresh"
  ): Promise<void> => {
    const upstream = await route.fetch();
    const forceStaleTarget =
      staleMode === "always" ||
      (staleMode === "after-refresh" && refreshRequests > 0);
    if (!forceStaleTarget || !sessionTargetSourceId) {
      await route.fulfill({ response: upstream });
      return;
    }
    const staleTarget = initialSourceById.get(sessionTargetSourceId);
    const payload = (await upstream.json().catch(() => null)) as
      | (Record<string, unknown> & {
          sources?: Array<Record<string, unknown> & { id?: unknown }>;
        })
      | null;
    if (!staleTarget || !payload) {
      await route.fulfill({ response: upstream });
      return;
    }
    const peerSources = (payload.sources ?? []).filter(
      (source) => source.id !== sessionTargetSourceId
    );
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        streamUrl:
          typeof staleTarget.url === "string"
            ? staleTarget.url
            : payload.streamUrl,
        sources: [staleTarget, ...peerSources],
      },
    });
  };

  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const isPlaybackRequest =
      requestUrl.pathname.includes("/api/playback/");
    const isRefreshRequest =
      isPlaybackRequest &&
      requestUrl.searchParams.get("refresh") === "1";
    if (isRefreshRequest) {
      refreshRequests += 1;
      if (SESSION_EXHAUSTION_MODE && sessionTargetSourceId) {
        await fulfillPlaybackResponse(route, "always");
        return;
      }
      await route.continue();
      return;
    }
    if (isPlaybackRequest && SESSION_EXHAUSTION_MODE) {
      // A slow full resolve can begin before the injected 410, then settle
      // after the explicit refresh. If that late response carries a live URL
      // it accidentally rescues the target and the gate never exercises the
      // second-expiry path. Fetch every playback response under this isolated
      // mode and decide when its response arrives: once refresh has started,
      // every overlapping/polled roster must retain the deliberately stale
      // target until the player proves bounded exhaustion and peer failover.
      await fulfillPlaybackResponse(route, "after-refresh");
      return;
    }
    const mediaRequest = isMediaRequest(route);
    let shouldInject = faultInjectionEnabled && !refreshCompleted && mediaRequest;
    if (
      faultInjectionEnabled &&
      SESSION_EXPIRY_MODE &&
      mediaRequest &&
      sessionTargetSourceId
    ) {
      let activeSourceId: string | null = null;
      try {
        activeSourceId = await route
          .request()
          .frame()
          .page()
          .locator("video")
          .getAttribute("data-playback-source-id");
      } catch {
        // Worker/orphan requests have no frame and cannot be tied safely to
        // the logical source under test, so let them continue.
      }
      shouldInject =
        activeSourceId === sessionTargetSourceId &&
        (SESSION_EXHAUSTION_MODE || !refreshCompleted);
    }
    if (shouldInject) {
      if (firstInjectedFailureAt == null) firstInjectedFailureAt = Date.now();
      injectedFailures += 1;
      injectedRequests.add(route.request());
      await route.fulfill({
        status: FAILURE_STATUS,
        contentType: "text/plain",
        body: `${FAILURE_STATUS} roster-refresh release-gate injection`,
      });
      return;
    }
    if (refreshCompleted && mediaRequest) allowedMediaRequests += 1;
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
    if (
      refreshCompleted &&
      !injectedRequests.has(response.request()) &&
      isMediaRequest({ request: () => response.request() } as Route)
    ) {
      postRefreshMediaStatuses.push(response.status());
    }
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes("/api/playback/")) return;
    const payload = (await response.json().catch(() => null)) as {
      partial?: unknown;
      sources?: Array<Record<string, unknown> & { id?: unknown; url?: unknown }>;
    } | null;
    const sourceIds = (payload?.sources ?? [])
      .map((source) => source.id)
      .filter((id): id is string => typeof id === "string");
    if (!refreshCompleted && url.searchParams.get("refresh") !== "1") {
      for (const source of payload?.sources ?? []) {
        if (typeof source.id !== "string") continue;
        initialSourceIds.add(source.id);
        initialSourceById.set(source.id, {
          ...source,
          id: source.id,
        });
      }
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
    if (SESSION_EXPIRY_MODE) {
      await page.waitForFunction(
        () => {
          const video = document.querySelector("video");
          return (
            video instanceof HTMLVideoElement &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth > 0 &&
            !video.paused
          );
        },
        undefined,
        { timeout: 45_000 }
      );
      // Progressive MP4 hides HTTP status behind MEDIA_ERR_NETWORK. Select a
      // real adaptive server so the injected 410 reaches hls.js's structured
      // response path and proves signed-session renewal specifically.
      sessionTargetSourceId = await selectRealHlsSource(page, (sourceId) => {
        sessionTargetSourceId = sourceId;
        faultInjectionEnabled = true;
      });
      const refreshDeadline = Date.now() + 45_000;
      while (!refreshCompleted && Date.now() < refreshDeadline) {
        const activeSourceId = await page
          .locator("video")
          .getAttribute("data-playback-source-id")
          .catch(() => null);
        if (
          sessionTargetSourceId &&
          activeSourceId &&
          activeSourceId !== sessionTargetSourceId
        ) {
          prematureSessionSourceSwitches.add(activeSourceId);
        }
        await page.waitForTimeout(250);
      }
      if (!refreshCompleted) {
        throw new Error("HLS 410 did not produce a completed refresh request");
      }
      await page.locator("video").evaluate((video: HTMLVideoElement) => {
        video.dataset.refreshGateTime = String(video.currentTime);
      });
    }
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
    const sessionTargetFailures = playerFailureRecords.filter(
      (failure) => failure.sourceId === sessionTargetSourceId
    );

    if (SESSION_EXHAUSTION_MODE) {
      check(
        "repeated session expiry is bounded and fails over the expired source",
        injectedFailures >= 2 &&
          sessionTargetSourceId != null &&
          sessionTargetFailures.length === 1 &&
          sessionTargetFailures[0]?.reason ===
            "hls_session_refresh_exhausted" &&
          state.sourceId !== sessionTargetSourceId,
        `${injectedFailures} forced 410 response(s); ` +
          `${sessionTargetFailures.length} target failure(s); ` +
          `final=${state.sourceId ?? "none"}`
      );
    } else if (SESSION_EXPIRY_MODE) {
      check(
        "session expiry is absorbed without failing the logical source",
        injectedFailures >= 1 &&
          sessionTargetSourceId != null &&
          sessionTargetFailures.length === 0,
        `${injectedFailures} forced 410 response(s); ` +
          `${sessionTargetFailures.length} target-source failure(s)`
      );
    } else {
      check(
        "the initial roster was actually exhausted",
        injectedFailures >= initialSourceIds.size && everyInitialSourceFailed,
        `${injectedFailures} forced failure(s); initial=${[...initialSourceIds].join(",") || "none"}; ` +
          `failed=${[...failedInitialIds].join(",") || "none"}`
      );
    }
    if (SESSION_EXPIRY_MODE) {
      check(
        "the selected session source remains owned until refresh resolves",
        prematureSessionSourceSwitches.size === 0,
        prematureSessionSourceSwitches.size === 0
          ? sessionTargetSourceId ?? "no target"
          : `switched early to ${[...prematureSessionSourceSwitches].join(",")}`
      );
    }
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
    if (SESSION_EXHAUSTION_MODE) {
      check(
        "session refresh exhaustion produces one generation-owned terminal claim",
        sessionTargetFailures.length === 1 &&
          sessionTargetFailures[0]?.generation > 0,
        `${sessionTargetFailures.length} failure(s) for ${sessionTargetSourceId}`
      );
    } else if (SESSION_EXPIRY_MODE) {
      check(
        "the renewed generation resumes without a terminal failure claim",
        sessionTargetFailures.length === 0,
        `${sessionTargetFailures.length} failure(s) for ${sessionTargetSourceId}`
      );
    } else {
      check(
        "the player surfaced generation-scoped failures during recovery",
        generationScopedFailures,
        `${playerFailureRecords.length}/${initialSourceIds.size} structured failure(s)`
      );
    }
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
    failureStatus: FAILURE_STATUS,
    sessionExpiryMode: SESSION_EXPIRY_MODE,
    sessionExhaustionMode: SESSION_EXHAUSTION_MODE,
    sessionTargetSourceId,
    prematureSessionSourceSwitches: [...prematureSessionSourceSwitches],
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
