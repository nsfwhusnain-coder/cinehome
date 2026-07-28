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

import {
  chromium,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
} from "playwright";
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

interface Preferences {
  playbackQuality: "auto" | number;
  audioLanguage: string;
}

interface MediaObservation {
  kind: "playback" | "hls" | "media";
  path: string;
  status: number;
}

const BASE = (process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
const STORAGE_STATE =
  process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";
const OUT_DIR =
  process.env.ADAPTIVE_OUT_DIR || "/app/.browser-qa/adaptive-controls-pass";
const WATCH_PATH = process.env.ADAPTIVE_WATCH_PATH || "/watch/movie/550";
const TARGET_PROVIDER = (process.env.ADAPTIVE_SOURCE_PROVIDER || "Vixsrc").toLowerCase();
const TARGET_ID = (process.env.ADAPTIVE_SOURCE_ID || "vixsrc-luna").toLowerCase();
const checks: Check[] = [];
const mediaObservations: MediaObservation[] = [];

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

function observeMediaResponse(response: PlaywrightResponse): void {
  const url = new URL(response.url());
  const sameOrigin = url.origin === BASE_ORIGIN;
  const isPlayback = sameOrigin && url.pathname.startsWith("/api/playback/");
  const isHls = sameOrigin && url.pathname.startsWith("/api/hls/");
  const isMedia = response.request().resourceType() === "media";
  if (!isPlayback && !isHls && !isMedia) return;
  mediaObservations.push({
    kind: isPlayback ? "playback" : isHls ? "hls" : "media",
    path: sameOrigin ? url.pathname : "[external-media]",
    status: response.status(),
  });
}

function auditMediaContract(): void {
  const observedMedia = mediaObservations.filter(
    (observation) => observation.kind === "hls" || observation.kind === "media"
  );
  record(
    "adaptive playback traverses observed media requests",
    observedMedia.length > 0,
    `${observedMedia.length} media response(s)`
  );
  const failures = mediaObservations.filter(
    (observation) =>
      observation.status === 403 ||
      observation.status === 428 ||
      observation.status === 429 ||
      observation.status >= 500
  );
  record(
    "adaptive playback avoids authorization, dead-source, rate-limit, and server errors",
    failures.length === 0,
    failures.length
      ? failures
          .map(
            (observation) =>
              `${observation.status} ${observation.kind} ${observation.path}`
          )
          .join(", ")
      : undefined
  );
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

function decodedQualityHeight(state: VideoState): number | null {
  const longEdge = Math.max(state.width, state.height);
  const shortEdge = Math.min(state.width, state.height);
  if (longEdge >= 3_800 || shortEdge >= 1_800) return 2160;
  if (longEdge >= 2_500 || shortEdge >= 1_400) return 1440;
  if (longEdge >= 1_900 || shortEdge >= 850) return 1080;
  if (longEdge >= 1_200 || shortEdge >= 600) return 720;
  if (longEdge >= 700 || shortEdge >= 400) return 480;
  if (longEdge >= 630 || shortEdge >= 340) return 360;
  if (longEdge >= 560 || shortEdge >= 280) return 320;
  return null;
}

function qualityLabel(height: number | null): string {
  if (height == null) return "";
  return height === 2160 ? "4K" : `${height}p`;
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

async function waitForDecodedRung(
  page: Page,
  expectedHeight: number,
  expectedSourceId: string,
  timeout = 20_000
): Promise<VideoState> {
  const started = Date.now();
  let current = await state(page);
  while (Date.now() - started < timeout) {
    if (
      current.sourceId === expectedSourceId &&
      decodedQualityHeight(current) === expectedHeight &&
      !current.paused &&
      current.readyState >= 2
    ) {
      const at = current.currentTime;
      await page.waitForTimeout(800);
      const advanced = await state(page);
      if (
        advanced.sourceId === expectedSourceId &&
        decodedQualityHeight(advanced) === expectedHeight &&
        advanced.currentTime > at + 0.3
      ) {
        return advanced;
      }
    }
    await page.waitForTimeout(300);
    current = await state(page);
  }
  throw new Error(
    `decoded rung did not reach ${qualityLabel(expectedHeight)} on ${expectedSourceId}; ` +
      `last=${current.width}x${current.height}/${qualityLabel(decodedQualityHeight(current)) || "unknown"} ` +
      `source=${current.sourceId || "none"}`
  );
}

async function preferences(page: Page): Promise<Preferences> {
  return page.evaluate(async () => {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error(`preferences GET ${response.status}`);
    return response.json();
  });
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
    serviceWorkers: "block",
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const sources = new Map<string, PublicSource>();

  page.on("response", async (response) => {
    observeMediaResponse(response);
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
    const decodedHeight = decodedQualityHeight(autoSteady);
    const decodedLabel = qualityLabel(decodedHeight);
    record(
      "Auto reports actual decoded quality",
      autoSteady.sourceId === target.id &&
        decodedLabel !== "" &&
        autoText.includes(decodedLabel),
      `advertised=${target.maxHeight || "unknown"}; actual=${autoSteady.width}x${autoSteady.height}; ` +
        `source=${autoSteady.sourceId || "none"}; row=${autoText}`
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
      const highState = await waitForDecodedRung(page, highest, target.id);
      record(
        "fixed highest quality changes the real decoder",
        "pass",
        `${highState.width}x${highState.height}; source=${highState.sourceId}`
      );
    }
    if (Number.isFinite(lowest) && lowest > 0 && lowest < highest) {
      await chooseQuality(page, lowest);
      const lowState = await waitForDecodedRung(page, lowest, target.id);
      record(
        "fixed lower quality changes the real decoder",
        "pass",
        `${lowState.width}x${lowState.height}; source=${lowState.sourceId}`
      );
      await chooseQuality(page, highest);
      const restored = await waitForDecodedRung(page, highest, target.id);
      record(
        "quality can switch back up without source failover",
        restored.sourceId === target.id,
        `${restored.width}x${restored.height}; source=${restored.sourceId}`
      );
    }

    const uiHas320Rung = qualityHeights.includes(320);
    const metadataHas320Rung = target.ladder.includes(320);
    if (!uiHas320Rung) {
      record(
        "real 320p rendition switch preserves the profile default",
        metadataHas320Rung ? "fail" : "skip",
        metadataHas320Rung
          ? `source metadata advertises 320p but the enabled player ladder is ${qualityHeights.join("/") || "empty"}`
          : `source has no enabled 320p rung; metadata=${target.ladder.join("/") || "unknown"}; ` +
              `enabled=${qualityHeights.join("/") || "empty"}`
      );
    } else {
      const profileBefore320 = await preferences(page);
      await chooseQuality(page, 320);
      const decoded320 = await waitForDecodedRung(page, 320, target.id);
      const profileAfter320 = await preferences(page);
      record(
        "real 320p rendition switch preserves the profile default",
        profileAfter320.playbackQuality === profileBefore320.playbackQuality &&
          profileAfter320.audioLanguage === profileBefore320.audioLanguage,
        `${decoded320.width}x${decoded320.height}; source=${decoded320.sourceId}; ` +
          `profile=${String(profileBefore320.playbackQuality)}`
      );
    }

    await auditOptionalTracks(page, "Audio");
    await auditOptionalTracks(page, "Subtitles");

    await page.screenshot({ path: join(OUT_DIR, "adaptive-controls.png") });
  } catch (error) {
    record("adaptive control pass completed", "fail", safeError(error));
  } finally {
    auditMediaContract();
    await context.close();
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    watchPath: WATCH_PATH,
    targetProvider: TARGET_PROVIDER,
    targetId: TARGET_ID,
    mediaObservations,
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
