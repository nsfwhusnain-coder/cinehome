#!/usr/bin/env bun
/**
 * Commercial-player acceptance pass for the Cineby-inspired playback sheet.
 *
 * It verifies the product contract through the rendered UI:
 * - one stable Quality/Sources/Subtitles/Audio/Speed sheet;
 * - Auto plus the same named quality rail on every title;
 * - only real, usable source rows, with stable IDs/names/region treatment;
 * - profile default persistence without a session switch mutating the profile;
 * - source switches preserve position and a paused switch remains paused;
 * - the sheet fits desktop and phone viewports.
 *
 * Required:
 *   STORAGE_STATE=/app/.browser-qa/storage-state.json
 *
 * Optional:
 *   CINEHOME_BASE_URL=http://127.0.0.1:4447
 *   CINEBY_PLAYER_WATCH_PATH=/watch/movie/550
 *   CINEBY_PLAYER_OUT_DIR=/app/.browser-qa/cineby-player-pass
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ViewportName = "desktop" | "mobile";
type CheckState = "pass" | "fail" | "skip";

interface Check {
  viewport: ViewportName;
  name: string;
  state: CheckState;
  detail?: string;
}

interface SafeSource {
  id: string;
  provider: string;
  verified: boolean | null;
  probeOk: boolean | null;
}

interface VideoState {
  currentTime: number;
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

const BASE = (process.env.CINEHOME_BASE_URL || "http://127.0.0.1:4447").replace(/\/$/, "");
const STORAGE_STATE =
  process.env.STORAGE_STATE || "/app/.browser-qa/storage-state.json";

async function ensureBaseCookieScope(context: BrowserContext): Promise<void> {
  const baseHost = new URL(BASE).hostname;
  const storedCookies = await context.cookies();
  const missingBaseScope = storedCookies.filter(
    (cookie) => cookie.domain !== baseHost
  );
  if (!missingBaseScope.length) return;
  await context.addCookies(
    missingBaseScope.map((cookie) => ({
      ...cookie,
      domain: baseHost,
    }))
  );
}
const OUT_DIR =
  process.env.CINEBY_PLAYER_OUT_DIR || "/app/.browser-qa/cineby-player-pass";
const WATCH_PATH = process.env.CINEBY_PLAYER_WATCH_PATH || "/watch/movie/550";
const EXPECTED_TABS = ["Quality", "Sources", "Subtitles", "Audio", "Speed"];
const EXPECTED_QUALITIES = ["Auto", "4K", "1440p", "1080p", "720p", "480p", "360p"];
const checks: Check[] = [];

function record(
  viewport: ViewportName,
  name: string,
  stateOrPass: CheckState | boolean,
  detail?: string
): void {
  const state =
    typeof stateOrPass === "boolean"
      ? stateOrPass
        ? "pass"
        : "fail"
      : stateOrPass;
  checks.push({ viewport, name, state, detail });
  console.log(`CHECK ${viewport} ${state.toUpperCase()} ${name}${detail ? ` — ${detail}` : ""}`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
}

function sameList(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

async function state(page: Page): Promise<VideoState> {
  return page.locator("video").evaluate((video: HTMLVideoElement) => ({
    currentTime: video.currentTime,
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
  timeout = 60_000
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
    ({ wanted, at }) => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        (!wanted || video.dataset.playbackSourceId === wanted) &&
        video.currentTime >= at + 0.5
      );
    },
    { wanted: sourceId, at: first.currentTime },
    { timeout: 10_000 }
  );
  return state(page);
}

async function showControls(page: Page): Promise<void> {
  const box = await page.locator("video").boundingBox();
  if (box) await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + 20);
  await page.waitForTimeout(150);
}

async function openSheet(page: Page) {
  await showControls(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Player settings" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function closeSheet(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Player settings" });
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function preferences(page: Page): Promise<Preferences> {
  return page.evaluate(async () => {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error(`preferences GET ${response.status}`);
    return response.json();
  });
}

async function savePreferences(page: Page, value: Preferences): Promise<Preferences> {
  return page.evaluate(async (next) => {
    const response = await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) throw new Error(`preferences PATCH ${response.status}`);
    return response.json();
  }, value);
}

async function auditSheet(
  page: Page,
  viewport: ViewportName,
  apiSources: Map<string, SafeSource>
): Promise<{ sourceIds: string[]; qualityLabels: string[] }> {
  const dialog = await openSheet(page);
  const tabs = await dialog.getByRole("tab").allTextContents();
  const normalizedTabs = tabs.map((text) => text.trim());
  record(
    viewport,
    "one stable five-tab playback sheet",
    sameList(normalizedTabs, EXPECTED_TABS),
    normalizedTabs.join(" | ")
  );
  record(
    viewport,
    "legacy fake actions are absent",
    !/Download|Show \d+ more/i.test(await dialog.innerText())
  );

  await dialog.getByRole("tab", { name: "Quality", exact: true }).click();
  const qualityButtons = dialog
    .getByRole("button")
    .filter({ hasText: /^(?:Auto|4K|1440p|1080p|720p|480p|360p)(?:\s|$)/ });
  const qualityLabels = (await qualityButtons.allTextContents()).map((text) =>
    text.replace(/·.*$/, "").trim()
  );
  record(
    viewport,
    "quality rail is stable from Auto through 360p",
    sameList(qualityLabels, EXPECTED_QUALITIES),
    qualityLabels.join(" | ")
  );

  await dialog.getByRole("tab", { name: "Sources", exact: true }).click();
  const sourceRows = dialog.locator("button[data-source-id]");
  await sourceRows.first().waitFor({ state: "visible", timeout: 45_000 });
  const rows = await sourceRows.evaluateAll((buttons) =>
    buttons.map((button) => ({
      id: button.getAttribute("data-source-id") || "",
      provider: button.getAttribute("data-source-provider") || "",
      name: button.getAttribute("aria-label") || "",
      disabled: (button as HTMLButtonElement).disabled,
      hasRegion: Boolean(button.querySelector('[aria-label="Server region"]')),
      hasGlobal: Boolean(button.querySelector('[aria-label="Global server"]')),
      premium: Boolean(button.querySelector('[aria-label*="Premium"]')),
    }))
  );
  const sourceIds = rows.map((row) => row.id);
  const deadIds = rows
    .filter((row) => {
      const source = apiSources.get(row.id);
      return source?.verified === false || source?.probeOk === false;
    })
    .map((row) => row.id);
  record(
    viewport,
    "source list contains only real API sources",
    rows.length > 0 && rows.every((row) => row.id && row.provider && apiSources.has(row.id)),
    `${rows.length} usable rows`
  );
  record(
    viewport,
    "dead and failed sources are removed",
    deadIds.length === 0 && rows.every((row) => !row.disabled),
    deadIds.length ? deadIds.join(", ") : "none"
  );
  record(
    viewport,
    "server names are stable and unique",
    rows.every((row) => row.name) && new Set(rows.map((row) => row.name)).size === rows.length,
    rows.map((row) => `${row.name} (${row.provider}/${row.id})`).join(" | ")
  );
  const regionRows = rows.filter((row) => row.hasRegion || row.hasGlobal || row.premium).length;
  record(
    viewport,
    "servers carry a region flag or premium identity",
    regionRows === rows.length,
    `${regionRows}/${rows.length}`
  );

  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  record(
    viewport,
    "sheet stays inside the viewport",
    bounds.left >= 0 &&
      bounds.top >= 0 &&
      bounds.right <= bounds.viewportWidth &&
      bounds.bottom <= bounds.viewportHeight,
    JSON.stringify(bounds)
  );
  await page.screenshot({ path: join(OUT_DIR, `${viewport}-sources.png`) });
  await closeSheet(page);
  return { sourceIds, qualityLabels };
}

async function selectSource(
  page: Page,
  targetId: string,
  expectPlaying: boolean
): Promise<VideoState> {
  const dialog = await openSheet(page);
  await dialog.getByRole("tab", { name: "Sources", exact: true }).click();
  await dialog.locator(`button[data-source-id="${targetId}"]`).click();
  await closeSheet(page);
  if (expectPlaying) return waitForAdvancingVideo(page, targetId);
  await page.waitForFunction(
    (wanted) => {
      const video = document.querySelector("video");
      return (
        video instanceof HTMLVideoElement &&
        video.dataset.playbackSourceId === wanted &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.paused
      );
    },
    targetId,
    { timeout: 45_000 }
  );
  return state(page);
}

async function runDesktop(
  browser: Browser,
  apiSources: Map<string, SafeSource>
): Promise<void> {
  const viewport: ViewportName = "desktop";
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  page.on("response", async (response) => {
    if (!response.url().includes("/api/playback/") || !response.ok()) return;
    try {
      const payload = (await response.json()) as { sources?: unknown[] };
      for (const raw of payload.sources || []) {
        if (!raw || typeof raw !== "object") continue;
        const source = raw as Record<string, unknown>;
        if (typeof source.id !== "string" || typeof source.provider !== "string") continue;
        apiSources.set(source.id, {
          id: source.id,
          provider: source.provider,
          verified: typeof source.verified === "boolean" ? source.verified : null,
          probeOk:
            source.probe && typeof source.probe === "object" &&
            typeof (source.probe as Record<string, unknown>).ok === "boolean"
              ? ((source.probe as Record<string, unknown>).ok as boolean)
              : null,
        });
      }
    } catch {
      // The player itself surfaces malformed playback responses.
    }
  });

  try {
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    const initial = await waitForAdvancingVideo(page);
    record(
      viewport,
      "real playback reaches an advancing first frame",
      true,
      `${initial.width}x${initial.height} via ${initial.provider || "unknown"}`
    );
    await page.waitForTimeout(1_000);
    const initialProfile = await preferences(page);
    record(
      viewport,
      "profile exposes an explicit playback default",
      initialProfile.playbackQuality === "auto" ||
        typeof initialProfile.playbackQuality === "number",
      String(initialProfile.playbackQuality)
    );

    const audit = await auditSheet(page, viewport, apiSources);
    const alternate = audit.sourceIds.find((id) => id !== initial.sourceId);
    if (!alternate) {
      record(viewport, "playing source switch preserves position", "skip", "only one usable source");
      record(viewport, "paused source switch remains paused", "skip", "only one usable source");
    } else {
      const beforeSwitch = await state(page);
      const switched = await selectSource(page, alternate, true);
      record(
        viewport,
        "playing source switch preserves position",
        switched.currentTime >= Math.max(0, beforeSwitch.currentTime - 8),
        `${beforeSwitch.currentTime.toFixed(1)}s → ${switched.currentTime.toFixed(1)}s`
      );

      await page.keyboard.press("Space");
      await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return video instanceof HTMLVideoElement && video.paused;
      });
      const pausedBefore = await state(page);
      const returnTarget =
        audit.sourceIds.find((id) => id !== alternate) || initial.sourceId;
      if (returnTarget) {
        const pausedAfter = await selectSource(page, returnTarget, false);
        record(
          viewport,
          "paused source switch remains paused",
          pausedAfter.paused &&
            pausedAfter.currentTime >= Math.max(0, pausedBefore.currentTime - 8),
          `${pausedBefore.currentTime.toFixed(1)}s → ${pausedAfter.currentTime.toFixed(1)}s`
        );
      } else {
        record(viewport, "paused source switch remains paused", "skip", "no return source");
      }
    }

    const afterSessionSwitch = await preferences(page);
    record(
      viewport,
      "session switches do not overwrite the profile default",
      afterSessionSwitch.playbackQuality === initialProfile.playbackQuality
    );

    const testProfile: Preferences = {
      playbackQuality: initialProfile.playbackQuality === 720 ? 480 : 720,
      audioLanguage: initialProfile.audioLanguage,
    };
    const saved = await savePreferences(page, testProfile);
    const readBack = await preferences(page);
    record(
      viewport,
      "fixed quality default persists to the profile",
      saved.playbackQuality === testProfile.playbackQuality &&
        readBack.playbackQuality === testProfile.playbackQuality,
      String(readBack.playbackQuality)
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAdvancingVideo(page);
    const profileDialog = await openSheet(page);
    await profileDialog.getByRole("tab", { name: "Quality", exact: true }).click();
    const activeProfileQuality = profileDialog.getByRole("button", {
      name: new RegExp(`^${testProfile.playbackQuality}p(?:\\s|$)`),
      pressed: true,
    });
    record(
      viewport,
      "player initializes from the selected profile default",
      (await activeProfileQuality.count()) === 1,
      `${testProfile.playbackQuality}p`
    );
    await closeSheet(page);
    await savePreferences(page, initialProfile);
    const restored = await preferences(page);
    record(
      viewport,
      "profile default is restored after the isolated test",
      restored.playbackQuality === initialProfile.playbackQuality,
      String(restored.playbackQuality)
    );
  } catch (error) {
    record(viewport, "desktop Cineby-style player pass completed", false, safeError(error));
  } finally {
    await context.close();
  }
}

async function runMobile(
  browser: Browser,
  apiSources: Map<string, SafeSource>
): Promise<void> {
  const viewport: ViewportName = "mobile";
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    isMobile: true,
    hasTouch: true,
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  try {
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    await waitForAdvancingVideo(page);
    await page.waitForTimeout(1_000);
    await auditSheet(page, viewport, apiSources);
  } catch (error) {
    record(viewport, "mobile Cineby-style player pass completed", false, safeError(error));
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(`Storage state not found: ${STORAGE_STATE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const apiSources = new Map<string, SafeSource>();
  try {
    await runDesktop(browser, apiSources);
    await runMobile(browser, apiSources);
  } finally {
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    watchPath: WATCH_PATH,
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
  console.log(`CINEBY_PLAYER_REPORT ${reportPath}`);
  if (report.summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`CINEBY_PLAYER_FATAL ${safeError(error)}`);
  process.exit(1);
});
