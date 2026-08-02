#!/usr/bin/env bun

import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.CINEHOME_BASE_URL || "http://127.0.0.1:4445").replace(/\/$/, "");
const storageState = process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";
const outDir = process.env.RANDOM_ACCESS_OUT_DIR || "/app/.browser-qa/random-access-remux";
const watchPath = process.env.RANDOM_ACCESS_TITLE || "/watch/movie/283995";
const firstFrameTimeoutMs = Number(process.env.FIRST_FRAME_TIMEOUT_MS || "90_000");

interface ProbeReport {
  passed: boolean;
  watchPath: string;
  initial: Record<string, unknown>;
  targetSeconds: number;
  offsetRequests: Array<{ startAt: number; status?: number }>;
  landed: Record<string, unknown>;
  errors: string[];
}

if (!existsSync(storageState)) throw new Error(`Storage state missing: ${storageState}`);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: base,
  storageState,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(90_000);
const errors: string[] = [];
const offsetRequests: Array<{ startAt: number; status?: number }> = [];

page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("response", (response) => {
  const url = new URL(response.url());
  if (url.pathname !== "/api/transcode" || !url.searchParams.has("startAt")) return;
  const startAt = Number(url.searchParams.get("startAt"));
  if (Number.isFinite(startAt)) offsetRequests.push({ startAt, status: response.status() });
});

try {
  await page.goto(watchPath, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        video.currentTime > 0.5 &&
        video.videoWidth >= 1920 &&
        !video.paused
      );
    },
    undefined,
    { timeout: firstFrameTimeoutMs }
  );

  const slider = page.getByRole("slider", { name: "Seek" });
  const max = Number(await slider.getAttribute("aria-valuemax"));
  if (!Number.isFinite(max) || max < 30 * 60) {
    throw new Error(`Logical timeline is not the full title runtime: ${max}`);
  }

  const initial = await page.locator("video").evaluate((video: HTMLVideoElement) => ({
    currentSrc: video.currentSrc,
    currentTime: video.currentTime,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    logicalTime: Number(
      document.querySelector('[role="slider"][aria-label="Seek"]')?.getAttribute("aria-valuenow") || 0
    ),
    logicalDuration: Number(
      document.querySelector('[role="slider"][aria-label="Seek"]')?.getAttribute("aria-valuemax") || 0
    ),
  }));
  if (!String(initial.currentSrc).includes("/api/transcode")) {
    throw new Error(`Active source is not the remux path: ${initial.currentSrc}`);
  }

  const targetSeconds = max * 0.5;
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("5");

  await page.waitForFunction(
    ({ target }) => {
      const video = document.querySelector("video");
      const seek = document.querySelector('[role="slider"][aria-label="Seek"]');
      const logical = Number(seek?.getAttribute("aria-valuenow") || 0);
      return (
        video instanceof HTMLVideoElement &&
        video.currentSrc.includes("startAt=") &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.paused &&
        Math.abs(logical - target) <= 3
      );
    },
    { target: targetSeconds },
    { timeout: 90_000 }
  );

  const beforeAdvance = Number(await slider.getAttribute("aria-valuenow"));
  await page.waitForFunction(
    ({ before }) => {
      const seek = document.querySelector('[role="slider"][aria-label="Seek"]');
      return Number(seek?.getAttribute("aria-valuenow") || 0) >= before + 0.75;
    },
    { before: beforeAdvance },
    { timeout: 8_000 }
  );

  const landed = await page.locator("video").evaluate((video: HTMLVideoElement) => ({
    currentSrc: video.currentSrc,
    currentTime: video.currentTime,
    duration: video.duration,
    readyState: video.readyState,
    paused: video.paused,
    logicalTime: Number(
      document.querySelector('[role="slider"][aria-label="Seek"]')?.getAttribute("aria-valuenow") || 0
    ),
  }));
  const successfulOffset = offsetRequests.some(
    (request) =>
      request.status === 200 && Math.abs(request.startAt - (targetSeconds - 6)) <= 2
  );
  if (!successfulOffset) {
    throw new Error(`No successful offset manifest near ${targetSeconds - 6}`);
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));

  await page.screenshot({ path: join(outDir, "mid-title-landed.png") });
  const report: ProbeReport = {
    passed: true,
    watchPath,
    initial,
    targetSeconds,
    offsetRequests,
    landed,
    errors,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    passed: false,
    watchPath,
    error: error instanceof Error ? error.message : String(error),
    offsetRequests,
    errors,
  };
  await page.screenshot({ path: join(outDir, "failure.png") }).catch(() => undefined);
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
