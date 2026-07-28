#!/usr/bin/env bun
/**
 * Real adaptive-stream control pass.
 *
 * The normal product pass starts on the best default source, which is often a
 * fixed-quality debrid MP4. This harness deliberately chooses a real HLS
 * source through the visible Servers UI, then exercises the actual Quality,
 * Audio, and Subtitles menus without reaching into React/Zustand internals.
 *
 * Required:
 *   STORAGE_STATE=/app/.browser-qa/storage-state.json
 *
 * Optional:
 *   CINEHOME_BASE_URL=http://100.89.184.84:4445
 *   ADAPTIVE_SOURCE_PROVIDER=Vixsrc
 *   ADAPTIVE_SOURCE_ID=vixsrc-luna
 *   ADAPTIVE_WATCH_PATH=/watch/movie/550
 *   ADAPTIVE_OUT_DIR=/app/.browser-qa/adaptive-controls-pass
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PublicSource {
  id: string;
  provider: string;
  label: string;
  type: string;
  maxHeight: number;
  ladder: number[];
  verified: boolean | null;
  probeOk: boolean | null;
}

interface Check {
  name: string;
  state: "pass" | "fail" | "skip";
  detail?: string;
}

interface VideoState {
  currentTime: number;
  duration: number;
  paused: boolean;
  readyState: number;
  width: number;
  height: number;
  sourceId: string | null;
  provider: string | null;
}

const BASE = (process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445").replace(/\/$/, "");
const STORAGE_STATE =
  process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";
const OUT_DIR =
  process.env.ADAPTIVE_OUT_DIR || "/app/.browser-qa/adaptive-controls-pass";
const WATCH_PATH = process.env.ADAPTIVE_WATCH_PATH || "/watch/movie/550";
const TARGET_PROVIDER = (process.env.ADAPTIVE_SOURCE_PROVIDER || "Vixsrc").toLowerCase();
const TARGET_ID = (process.env.ADAPTIVE_SOURCE_ID || "vixsrc-luna").toLowerCase();
const checks: Check[] = [];

async function ensureBaseCookieScope(context: BrowserContext): Promise<void> {
  const baseHost = new URL(BASE).hostname;
  const cookies = await context.cookies();
  const clones = cookies
    .filter((cookie) => cookie.domain !== baseHost)
    .map((cookie) => ({ ...cookie, domain: baseHost }));
  if (clones.length) await context.addCookies(clones);
}

function record(
  name: string,
  stateOrPass: Check["state"] | boolean,
  detail?: string
): void {
  const state: Check["state"] =
    typeof stateOrPass === "boolean" ? (stateOrPass ? "pass" : "fail") : stateOrPass;
  checks.push({ name, state, detail });
  console.log(`CHECK ${state.toUpperCase()} ${name}${detail ? ` — ${detail}` : ""}`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
}

function publicSource(value: unknown): PublicSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.id !== "string" ||
    typeof source.provider !== "string" ||
    typeof source.type !== "string"
  ) {
    return null;
  }
  return {
    id: source.id,
    provider: source.provider,
    label: typeof source.label === "string" ? source.label : "",
    type: source.type,
    maxHeight: typeof source.maxHeight === "number" ? source.maxHeight : 0,
    ladder: Array.isArray(source.ladder)
      ? source.ladder.filter((height): height is number => typeof height === "number")
      : [],
    verified: typeof source.verified === "boolean" ? source.verified : null,
    probeOk:
      source.probe && typeof source.probe === "object"
        ? typeof (source.probe as Record<string, unknown>).ok === "boolean"
          ? ((source.probe as Record<string, unknown>).ok as boolean)
          : null
        : null,
  };
}

async function state(page: Page): Promise<VideoState> {
  return page.locator("video").evaluate((video: HTMLVideoElement) => ({
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: video.paused,
    readyState: video.readyState,
    width: video.videoWidth,
    height: video.videoHeight,
    sourceId: video.dataset.playbackSourceId || null,
    provider: video.dataset.playbackSourceProvider || null,
  }));
}

async function waitForAdvancingVideo(
  page: Page,
  sourceId?: string,
  timeout = 45_000
): Promise<VideoState> {
  await page.waitForFunction(
    (wanted) => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        (!wanted || video.dataset.playbackSourceId === wanted) &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        !video.paused &&
        video.currentTime > 0
      );
    },
    sourceId,
    { timeout }
  );
  const first = await state(page);
  await page.waitForFunction(
    ({ source, at }) => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        (!source || video.dataset.playbackSourceId === source) &&
        video.currentTime >= at + 0.75
      );
    },
    { source: sourceId, at: first.currentTime },
    { timeout: 10_000 }
  );
  return state(page);
}

async function showControls(page: Page): Promise<void> {
  const box = await page.locator("video").boundingBox();
  if (box) await page.mouse.move(box.x + 20, box.y + 20);
  await page.waitForTimeout(150);
}

async function openSettings(page: Page) {
  await showControls(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Player settings" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function openSection(page: Page, section: "Quality" | "Audio" | "Subtitles") {
  const dialog = await openSettings(page);
  await dialog.getByRole("tab", { name: section, exact: true }).click();
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const dialog = page.getByRole("dialog", { name: "Player settings" });
  await dialog.waitFor({ state: "hidden" });
}

function qualityHeight(label: string): number {
  const match = label.match(/\b(\d{3,4})p\b/i);
  return match ? Number(match[1]) : 0;
}

function decodedQualityLabel(state: VideoState): string {
  const longEdge = Math.max(state.width, state.height);
  const shortEdge = Math.min(state.width, state.height);
  if (longEdge >= 3_800 || shortEdge >= 1_800) return "4K";
  if (longEdge >= 2_500 || shortEdge >= 1_400) return "1440p";
  if (longEdge >= 1_900 || shortEdge >= 850) return "1080p";
  if (longEdge >= 1_200 || shortEdge >= 600) return "720p";
  if (longEdge >= 700 || shortEdge >= 400) return "480p";
  if (longEdge >= 630 || shortEdge >= 340) return "360p";
  if (longEdge >= 560 || shortEdge >= 280) return "320p";
  return "";
}

async function chooseQuality(page: Page, height: number): Promise<void> {
  const dialog = await openSection(page, "Quality");
  const label = height === 2160 ? "4K" : `${height}p`;
  const option = dialog
    .getByRole("button")
    .filter({ hasText: new RegExp(`^${label}(?:\\b|\\s)`, "i") })
    .first();
  await option.click();
  await closeSettings(page);
}

async function waitForDecodedHeight(
  page: Page,
  predicate: (height: number) => boolean,
  timeout = 20_000
): Promise<VideoState> {
  const started = Date.now();
  let current = await state(page);
  while (Date.now() - started < timeout) {
    if (predicate(current.height) && !current.paused && current.readyState >= 2) {
      const at = current.currentTime;
      await page.waitForTimeout(800);
      const advanced = await state(page);
      if (advanced.currentTime > at + 0.3) return advanced;
    }
    await page.waitForTimeout(300);
    current = await state(page);
  }
  throw new Error(`decoded height did not reach target; last=${current.height}`);
}

async function auditOptionalTracks(
  page: Page,
  section: "Audio" | "Subtitles"
): Promise<void> {
  const dialog = await openSection(page, section);
  const body = (await dialog.innerText()).replace(/\s+/g, " ").trim();
  const empty =
    section === "Audio"
      ? /No alternate audio|only has one audio track/i.test(body)
      : /No embedded subtitle tracks/i.test(body);

  const optionTexts = await dialog.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((text) => text && !/^(Back|Close)$/i.test(text))
  );

  if (empty || optionTexts.length <= (section === "Subtitles" ? 1 : 0)) {
    record(
      `${section.toLowerCase()} empty state is honest`,
      "skip",
      body.slice(0, 180)
    );
    await closeSettings(page);
    return;
  }

  const candidates = optionTexts.filter((text) =>
    section === "Subtitles" ? !/^Off$/i.test(text) : true
  );
  const pick = candidates.at(-1);
  if (!pick) {
    record(`${section.toLowerCase()} track selection`, "skip", "no selectable alternate");
    await closeSettings(page);
    return;
  }

  await dialog.getByRole("button").filter({ hasText: pick }).last().click();
  const rootText = (await dialog.innerText()).replace(/\s+/g, " ").trim();
  record(
    `${section.toLowerCase()} track selection updates the settings value`,
    rootText.toLowerCase().includes(pick.toLowerCase()),
    `selected=${pick}; root=${rootText.slice(0, 160)}`
  );
  await closeSettings(page);
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
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const sources = new Map<string, PublicSource>();

  page.on("response", async (response) => {
    if (!response.url().includes("/api/playback/") || !response.ok()) return;
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      const roster = Array.isArray(payload.sources) ? payload.sources : [];
      for (const raw of roster) {
        const source = publicSource(raw);
        if (source) sources.set(source.id, source);
      }
    } catch {
      // A malformed response is surfaced by the player; do not derail the pass.
    }
  });

  try {
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    const initial = await waitForAdvancingVideo(page);
    record(
      "default source reaches an advancing first frame",
      "pass",
      `${initial.width}x${initial.height} via ${initial.provider || "unknown"}`
    );

    // Give the progressive resolve a moment to publish its first UI update;
    // the response listener below owns the authoritative bounded roster wait.
    await page.waitForTimeout(1_000);
    const rosterDeadline = Date.now() + 45_000;
    let target: PublicSource | undefined;
    while (Date.now() < rosterDeadline) {
      target = [...sources.values()].find(
        (source) =>
          source.type.toLowerCase() === "hls" &&
          source.provider.toLowerCase().includes(TARGET_PROVIDER) &&
          source.id.toLowerCase().includes(TARGET_ID)
      );
      if (target) break;
      await page.waitForTimeout(250);
    }
    if (!target) throw new Error(`HLS target absent: provider=${TARGET_PROVIDER} id=${TARGET_ID}`);
    record(
      "adaptive source appears in the real roster",
      "pass",
      `${target.provider}/${target.id}; advertised=${target.maxHeight || "unknown"}; ladder=${target.ladder.join("/") || "unknown"}`
    );

    await showControls(page);
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    const servers = page.getByRole("dialog", { name: "Player settings" });
    await servers.waitFor({ state: "visible" });
    const sourceButton = servers.locator(`button[data-source-id="${target.id}"]`);
    await sourceButton.click();
    await closeSettings(page);
    const selected = await waitForAdvancingVideo(page, target.id);
    record(
      "adaptive source selection becomes healthy",
      "pass",
      `${selected.width}x${selected.height} via ${selected.provider}`
    );

    await page.waitForTimeout(10_000);
    const autoSteady = await state(page);
    const qualityDialog = await openSection(page, "Quality");
    const autoText = (
      await qualityDialog
        .getByRole("button")
        .filter({ hasText: /^Auto(?:\s|$)/i })
        .first()
        .innerText()
    )
      .replace(/\s+/g, " ")
      .trim();
    const decodedLabel = decodedQualityLabel(autoSteady);
    record(
      "Auto reports actual decoded quality",
      decodedLabel !== "" && autoText.includes(decodedLabel),
      `advertised=${target.maxHeight || "unknown"}; actual=${autoSteady.width}x${autoSteady.height}; row=${autoText}`
    );

    const qualityRows = await qualityDialog.getByRole("button").evaluateAll((buttons) =>
      buttons
        .map((button) => ({
          text: button.textContent?.replace(/\s+/g, " ").trim() || "",
          disabled: (button as HTMLButtonElement).disabled,
        }))
        .filter((row) => /^Auto\b|^4K\b|^\d{3,4}p\b/i.test(row.text))
    );
    const qualityTexts = qualityRows.map((row) => row.text);
    const qualityHeights = qualityRows
      .filter((row) => !row.disabled)
      .map((row) => (row.text.startsWith("4K") ? 2160 : qualityHeight(row.text)))
      .filter((height) => height > 0);
    record(
      "quality menu exposes the adaptive ladder",
      qualityHeights.length >= 2,
      qualityTexts.join(" | ")
    );
    await closeSettings(page);

    const highest = Math.max(...qualityHeights);
    const lowest = Math.min(...qualityHeights);
    if (Number.isFinite(highest) && highest > 0) {
      await chooseQuality(page, highest);
      const highState = await waitForDecodedHeight(page, (height) => height >= highest * 0.9);
      record(
        "fixed highest quality changes the real decoder",
        "pass",
        `${highState.width}x${highState.height}`
      );
    }
    if (Number.isFinite(lowest) && lowest > 0 && lowest < highest) {
      await chooseQuality(page, lowest);
      const lowState = await waitForDecodedHeight(page, (height) => height <= lowest * 1.1);
      record(
        "fixed lower quality changes the real decoder",
        "pass",
        `${lowState.width}x${lowState.height}`
      );
      await chooseQuality(page, highest);
      const restored = await waitForDecodedHeight(page, (height) => height >= highest * 0.9);
      record(
        "quality can switch back up without source failover",
        restored.sourceId === target.id,
        `${restored.width}x${restored.height}; source=${restored.sourceId}`
      );
    }

    await auditOptionalTracks(page, "Audio");
    await auditOptionalTracks(page, "Subtitles");

    await page.screenshot({ path: join(OUT_DIR, "adaptive-controls.png") });
  } catch (error) {
    record("adaptive control pass completed", "fail", safeError(error));
  } finally {
    await context.close();
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    watchPath: WATCH_PATH,
    targetProvider: TARGET_PROVIDER,
    targetId: TARGET_ID,
    summary: {
      pass: checks.filter((check) => check.state === "pass").length,
      fail: checks.filter((check) => check.state === "fail").length,
      skip: checks.filter((check) => check.state === "skip").length,
    },
    checks,
  };
  const reportPath = join(OUT_DIR, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`ADAPTIVE_CONTROLS_REPORT ${reportPath}`);
  if (report.summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`ADAPTIVE_CONTROLS_FATAL ${safeError(error)}`);
  process.exit(1);
});
