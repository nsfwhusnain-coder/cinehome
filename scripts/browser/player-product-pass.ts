#!/usr/bin/env bun
/**
 * CineHome interactive player product pass.
 *
 * This complements ownership-baseline.ts: that harness proves real playback,
 * seek and failover timings; this one exercises the controls a user touches.
 *
 * Run against production from the production image:
 *   docker run --rm --network host \
 *     -e STORAGE_STATE=/app/.browser-qa/storage-state.json \
 *     -v /home/hussy/cinehome/.browser-qa:/app/.browser-qa \
 *     -v /home/hussy/cinehome/scripts/browser/player-product-pass.ts:/tmp/player-product-pass.ts:ro \
 *     <image-id> bun /tmp/player-product-pass.ts
 *
 * Optional:
 *   CINEHOME_BASE_URL=http://100.89.184.84:4445
 *   PLAYER_PRODUCT_OUT_DIR=/app/.browser-qa/player-product-pass
 *   PLAYER_PRODUCT_TITLE=/watch/movie/550
 *   PLAYER_PRODUCT_VIEWPORT=desktop|mobile|tv
 *   PLAYER_PRODUCT_EXPECT_TERMINAL=1  # synthetic no-source input contract
 *   FIRST_FRAME_TIMEOUT_MS=45000
 */

import {
  chromium,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
} from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ViewportName = "desktop" | "mobile" | "tv";
type CheckState = "pass" | "fail" | "skip";

interface Check {
  viewport: ViewportName;
  name: string;
  state: CheckState;
  detail?: string;
}

interface VideoState {
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  activeSourceId: string | null;
  activeProvider: string | null;
}

interface ApiResponseObservation {
  viewport: ViewportName;
  path: string;
  status: number;
  mode: "fast" | "full" | "recovery" | null;
  cache: string | null;
}

const BASE = (process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
const STORAGE_STATE =
  process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";
const OUT_DIR =
  process.env.PLAYER_PRODUCT_OUT_DIR ||
  "/app/.browser-qa/player-product-pass";
const WATCH_PATH = process.env.PLAYER_PRODUCT_TITLE || "/watch/movie/550";
const VIEWPORT_FILTER = process.env.PLAYER_PRODUCT_VIEWPORT as ViewportName | undefined;
const EXPECT_TERMINAL = process.env.PLAYER_PRODUCT_EXPECT_TERMINAL === "1";
const FIRST_FRAME_TIMEOUT_MS = Number(process.env.FIRST_FRAME_TIMEOUT_MS || "45000");

const checks: Check[] = [];
const apiResponses: ApiResponseObservation[] = [];

function check(
  viewport: ViewportName,
  name: string,
  pass: boolean,
  detail?: string
): void {
  const item: Check = { viewport, name, state: pass ? "pass" : "fail", detail };
  checks.push(item);
  console.log(
    `CHECK ${viewport} ${item.state.toUpperCase()} ${name}${detail ? ` — ${detail}` : ""}`
  );
}

function skip(viewport: ViewportName, name: string, detail: string): void {
  checks.push({ viewport, name, state: "skip", detail });
  console.log(`CHECK ${viewport} SKIP ${name} — ${detail}`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

function observeApiResponse(
  viewport: ViewportName,
  response: PlaywrightResponse
): void {
  const url = new URL(response.url());
  if (url.origin !== BASE_ORIGIN) return;
  const isPlayback = url.pathname.startsWith("/api/playback/");
  if (!isPlayback && url.pathname !== "/api/system-status") return;
  const mode = isPlayback
    ? url.searchParams.get("refresh") === "1"
      ? "recovery"
      : url.searchParams.get("fast") === "1" ||
          url.searchParams.get("prefetch") === "1"
        ? "fast"
        : "full"
    : null;
  apiResponses.push({
    viewport,
    path: url.pathname,
    status: response.status(),
    mode,
    cache: response.headers()["x-playback-cache"] || null,
  });
}

function checkApiContract(viewport: ViewportName): void {
  const observed = apiResponses.filter((item) => item.viewport === viewport);
  const statusPolls = observed.filter(
    (item) => item.path === "/api/system-status"
  );
  check(
    viewport,
    "normal playback does not poll admin system status",
    statusPolls.length === 0,
    statusPolls.length ? `${statusPolls.length} unexpected request(s)` : undefined
  );
  const playbackFailures = observed.filter(
    (item) =>
      item.path.startsWith("/api/playback/") &&
      (item.status === 403 || item.status === 429 || item.status >= 500)
  );
  check(
    viewport,
    "playback API avoids authorization, rate-limit, and server errors",
    playbackFailures.length === 0,
    playbackFailures.length
      ? playbackFailures
          .map((item) => `${item.status} ${item.mode || "unknown"} ${item.path}`)
          .join(", ")
      : undefined
  );
}

async function videoState(page: Page): Promise<VideoState> {
  return page.locator("video").evaluate((video: HTMLVideoElement) => ({
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    readyState: video.readyState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    activeSourceId: video.dataset.playbackSourceId || null,
    activeProvider: video.dataset.playbackSourceProvider || null,
  }));
}

async function waitForFirstFrame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        video.currentTime > 0 &&
        !video.paused
      );
    },
    undefined,
    { timeout: FIRST_FRAME_TIMEOUT_MS }
  );
  const at = await videoState(page);
  await page.waitForFunction(
    (start) => {
      const video = document.querySelector("video");
      return video instanceof HTMLVideoElement && video.currentTime >= Number(start) + 0.75;
    },
    at.currentTime,
    { timeout: 8_000 }
  );
}

async function installTerminalPlaybackFault(page: Page): Promise<void> {
  await page.route("**/api/playback/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        message: "No stream available",
        sources: [],
      }),
    });
  });
}

async function runTerminalState(
  page: Page,
  viewport: ViewportName
): Promise<void> {
  const terminal = page.getByText(/No stream available|All servers are unavailable/i).first();
  await terminal.waitFor({ state: "visible", timeout: 35_000 });
  check(viewport, "terminal playback error is visible", true);

  const before = await videoState(page);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("KeyK");
  await page.waitForTimeout(500);
  const after = await videoState(page);
  check(
    viewport,
    "terminal state ignores playback and seek input",
    after.paused &&
      after.videoWidth === 0 &&
      after.videoHeight === 0 &&
      Math.abs(after.currentTime - before.currentTime) < 0.01,
    `${before.currentTime.toFixed(2)}s → ${after.currentTime.toFixed(2)}s, paused=${after.paused}`
  );

  const visibleTransportButtons = await page
    .getByRole("button", { name: /^(Play|Pause)$/ })
    .evaluateAll((buttons) =>
      buttons.filter((button) => {
        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      }).length
    );
  check(
    viewport,
    "terminal state hides contradictory transport controls",
    visibleTransportButtons === 0,
    `${visibleTransportButtons} visible Play/Pause control(s)`
  );
  check(
    viewport,
    "terminal error remains visible after input",
    await terminal.isVisible()
  );

  await page.screenshot({
    path: join(OUT_DIR, `${viewport}-terminal.png`),
  });
}

async function showControls(page: Page): Promise<void> {
  const video = page.locator("video");
  const box = await video.boundingBox();
  if (box) {
    await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + Math.min(20, box.height / 2));
  }
  await page.waitForTimeout(150);
}

async function ensurePlaying(page: Page): Promise<void> {
  const state = await videoState(page);
  if (!state.paused) return;
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && !video.paused;
  });
}

async function pressAndWaitForTime(
  page: Page,
  key: string,
  expected: (before: number, after: number) => boolean
): Promise<{ before: number; after: number }> {
  const before = (await videoState(page)).currentTime;
  await page.keyboard.press(key);
  await page.waitForFunction(
    ({ from, direction }) => {
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) return false;
      return direction === "forward"
        ? video.currentTime >= from + 7
        : video.currentTime <= from - 7;
    },
    { from: before, direction: key === "ArrowRight" ? "forward" : "back" },
    { timeout: 15_000 }
  );
  const after = (await videoState(page)).currentTime;
  if (!expected(before, after)) {
    throw new Error(`${key} moved ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  }
  return { before, after };
}

async function visibleControlLabels(page: Page): Promise<string[]> {
  return page.locator("button[aria-label]:visible").evaluateAll((buttons) =>
    buttons
      .map((button) => button.getAttribute("aria-label") || "")
      .filter(Boolean)
  );
}

async function inViewport(page: Page, label: string): Promise<boolean> {
  const locator = page.getByRole("button", { name: label, exact: true }).last();
  if (!(await locator.isVisible().catch(() => false))) return false;
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width >= 35.5 &&
      rect.height >= 35.5 &&
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= window.innerWidth &&
      rect.bottom <= window.innerHeight
    );
  });
}

async function runDesktop(page: Page): Promise<void> {
  const viewport: ViewportName = "desktop";
  await waitForFirstFrame(page);
  const initial = await videoState(page);
  check(viewport, "real first frame advances", true, `${initial.videoWidth}x${initial.videoHeight}`);

  const brokenImages = await page.locator("img").evaluateAll((images) =>
    images
      .filter(
        (image): image is HTMLImageElement =>
          image instanceof HTMLImageElement && image.complete && image.naturalWidth === 0
      )
      .map((image) => {
        try {
          return new URL(image.currentSrc || image.src).hostname || "relative";
        } catch {
          return "relative";
        }
      })
  );
  check(
    viewport,
    "loading and player artwork loads",
    brokenImages.length === 0,
    brokenImages.length ? `broken image hosts: ${[...new Set(brokenImages)].join(", ")}` : undefined
  );

  await showControls(page);
  const labels = await visibleControlLabels(page);
  const essentials = ["Pause", "Back 10s", "Forward 10s", "Mute", "Settings", "Fullscreen"];
  check(
    viewport,
    "essential controls are exposed",
    essentials.every((label) => labels.includes(label)),
    `visible: ${labels.join(", ")}`
  );

  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && video.paused;
  });
  check(viewport, "Space pauses without player focus", true);

  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && !video.paused;
  });
  check(viewport, "Space resumes without player focus", true);

  const muteBefore = (await videoState(page)).muted;
  await page.keyboard.press("m");
  await page.waitForFunction(
    (before) => {
      const video = document.querySelector("video");
      return video instanceof HTMLVideoElement && video.muted !== before;
    },
    muteBefore
  );
  check(viewport, "M toggles mute", true);

  const volumeBefore = (await videoState(page)).volume;
  const volumeKey = volumeBefore >= 0.95 ? "ArrowDown" : "ArrowUp";
  await page.keyboard.press(volumeKey);
  await page.waitForFunction(
    ({ before, key }) => {
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) return false;
      return key === "ArrowUp" ? video.volume > before : video.volume < before;
    },
    { before: volumeBefore, key: volumeKey }
  );
  check(viewport, "arrow key changes volume", true);

  const forward = await pressAndWaitForTime(
    page,
    "ArrowRight",
    (before, after) => after >= before + 7
  );
  check(viewport, "ArrowRight seeks forward", true, `${forward.before.toFixed(1)} -> ${forward.after.toFixed(1)}`);
  const back = await pressAndWaitForTime(
    page,
    "ArrowLeft",
    (before, after) => after <= before - 7
  );
  check(viewport, "ArrowLeft seeks backward", true, `${back.before.toFixed(1)} -> ${back.after.toFixed(1)}`);

  await page.keyboard.press("Shift+/");
  const shortcuts = page.getByText("Shortcuts", { exact: true });
  await shortcuts.waitFor({ state: "visible" });
  check(viewport, "? opens keyboard help", true);
  await page.keyboard.press("Escape");
  const shortcutsClosed = await shortcuts
    .waitFor({ state: "hidden", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  check(
    viewport,
    "Escape closes keyboard help",
    shortcutsClosed,
    shortcutsClosed ? undefined : "keyboard/remote focus is trapped in the overlay"
  );
  if (!shortcutsClosed) {
    await page.mouse.click(8, 100);
    await shortcuts.waitFor({ state: "hidden" });
  }

  await showControls(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Player settings" });
  await settings.waitFor({ state: "visible" });
  const focusInsideOnOpen = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Player settings"]');
    return !!dialog && dialog.contains(document.activeElement);
  });
  check(
    viewport,
    "settings moves focus into dialog",
    focusInsideOnOpen,
    focusInsideOnOpen ? undefined : "focus remains behind modal"
  );
  await page.keyboard.press("ArrowRight");
  const focusAfterArrow = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Player settings"]');
    const active = document.activeElement;
    return {
      inside: !!dialog && !!active && dialog.contains(active),
      text: active?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
    };
  });
  check(
    viewport,
    "D-pad arrow navigates settings",
    focusAfterArrow.inside,
    focusAfterArrow.text || "no focused settings control"
  );
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  check(viewport, "Escape closes settings", true);

  const fullscreenSupported = await page.evaluate(
    () => typeof document.documentElement.requestFullscreen === "function"
  );
  if (fullscreenSupported) {
    await page.keyboard.press("f");
    const entered = await page
      .waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    check(viewport, "F enters fullscreen", entered);
    if (entered) {
      await page.keyboard.press("f");
      const exited = await page
        .waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      check(viewport, "F exits fullscreen", exited);
    }
  } else {
    skip(viewport, "fullscreen keyboard path", "Fullscreen API unavailable in this browser");
  }

  await ensurePlaying(page);
  await showControls(page);
  const pipSupported = await page.evaluate(
    () =>
      "pictureInPictureEnabled" in document &&
      document.pictureInPictureEnabled &&
      typeof HTMLVideoElement.prototype.requestPictureInPicture === "function"
  );
  if (pipSupported) {
    const pipButton = page.getByRole("button", { name: "Picture in picture", exact: true });
    await pipButton.click();
    const entered = await page
      .waitForFunction(() => !!document.pictureInPictureElement, undefined, { timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    check(viewport, "PiP control enters picture-in-picture", entered);
    if (entered) {
      await page.evaluate(() => document.exitPictureInPicture());
    }
  } else {
    skip(viewport, "PiP control", "Picture-in-Picture API unavailable in headless Chromium");
  }
}

async function runCompactViewport(
  page: Page,
  viewport: Extract<ViewportName, "mobile" | "tv">
): Promise<void> {
  await waitForFirstFrame(page);
  const playing = await videoState(page);
  check(
    viewport,
    "real first frame advances",
    true,
    `${playing.videoWidth}x${playing.videoHeight}`
  );
  await showControls(page);

  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
  }));
  check(
    viewport,
    "player has no page overflow",
    layout.documentWidth <= layout.innerWidth && layout.documentHeight <= layout.innerHeight,
    `${layout.documentWidth}x${layout.documentHeight} in ${layout.innerWidth}x${layout.innerHeight}`
  );

  const required =
    viewport === "mobile"
      ? ["Pause", "Back 10s", "Forward 10s", "Mute", "Settings", "Fullscreen"]
      : ["Pause", "Settings", "Fullscreen"];
  const results = await Promise.all(required.map(async (label) => [label, await inViewport(page, label)] as const));
  const hidden = results.filter(([, visible]) => !visible).map(([label]) => label);
  check(
    viewport,
    "essential controls fit and meet 36px tap target",
    hidden.length === 0,
    hidden.length ? `off-screen or too small: ${hidden.join(", ")}` : undefined
  );

  const videoRect = await page.locator("video").evaluate((video) => {
    const rect = video.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
  check(
    viewport,
    "video remains inside viewport",
    videoRect.left >= 0 &&
      videoRect.top >= 0 &&
      videoRect.right <= layout.innerWidth &&
      videoRect.bottom <= layout.innerHeight,
    JSON.stringify(videoRect)
  );

  const screenshot = join(OUT_DIR, `${viewport}.png`);
  await page.screenshot({ path: screenshot });
}

async function makeContext(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  viewport: ViewportName
): Promise<BrowserContext> {
  const dimensions =
    viewport === "desktop"
      ? { width: 1440, height: 900 }
      : viewport === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1920, height: 1080 };
  return browser.newContext({
    viewport: dimensions,
    storageState: STORAGE_STATE,
    baseURL: BASE,
  });
}

async function runViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  viewport: ViewportName
): Promise<void> {
  console.log(`VIEWPORT ${viewport} START`);
  const context = await makeContext(browser, viewport);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("response", (response) => observeApiResponse(viewport, response));
  try {
    if (EXPECT_TERMINAL) await installTerminalPlaybackFault(page);
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    if (EXPECT_TERMINAL) await runTerminalState(page, viewport);
    else if (viewport === "desktop") await runDesktop(page);
    else await runCompactViewport(page, viewport);
  } catch (error) {
    check(viewport, "viewport pass completed", false, safeError(error));
  } finally {
    checkApiContract(viewport);
    await context.close();
    console.log(`VIEWPORT ${viewport} END`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(`Storage state not found: ${STORAGE_STATE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const viewports = (["desktop", "mobile", "tv"] as const).filter(
      (viewport) => !VIEWPORT_FILTER || viewport === VIEWPORT_FILTER
    );
    if (VIEWPORT_FILTER && viewports.length === 0) {
      throw new Error(`Unknown PLAYER_PRODUCT_VIEWPORT: ${VIEWPORT_FILTER}`);
    }
    for (const viewport of viewports) {
      await runViewport(browser, viewport);
    }
  } finally {
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    watchPath: WATCH_PATH,
    expectTerminal: EXPECT_TERMINAL,
    summary: {
      pass: checks.filter((item) => item.state === "pass").length,
      fail: checks.filter((item) => item.state === "fail").length,
      skip: checks.filter((item) => item.state === "skip").length,
    },
    checks,
    apiResponses,
  };
  const reportPath = join(OUT_DIR, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`PLAYER_PRODUCT_REPORT ${reportPath}`);
  if (report.summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`PLAYER_PRODUCT_FATAL ${safeError(error)}`);
  process.exit(1);
});
