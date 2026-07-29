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
  type Locator,
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

interface SafeSource {
  id: string;
  provider: string;
  verified: boolean | null;
  probeOk: boolean | null;
  compat: string | null;
  container: string | null;
}

interface RosterTracker {
  sources: Map<string, SafeSource>;
  fullResponseCount: number;
  failedSourceIds: Set<string>;
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

interface ApiResponseObservation {
  viewport: ViewportName;
  path: string;
  status: number;
  mode: "fast" | "full" | "recovery" | null;
  cache: string | null;
}

interface RosterObservation {
  viewport: ViewportName;
  settledMs: number;
  usableApiSourceIds: string[];
  displayedSourceIds: string[];
}

const BASE = (process.env.CINEHOME_BASE_URL || "http://127.0.0.1:4447").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
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
const EXPECTED_QUALITIES = ["Auto", "4K", "1440p", "1080p", "720p", "480p", "360p", "320p"];
const ROSTER_MIN_ENRICHMENT_MS = 12_000;
const ROSTER_SETTLE_MS = 3_000;
const ROSTER_TIMEOUT_MS = 45_000;
const checks: Check[] = [];
const apiResponses: ApiResponseObservation[] = [];
const rosterObservations: RosterObservation[] = [];

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

function observeApiResponse(
  viewport: ViewportName,
  response: PlaywrightResponse
): void {
  const url = new URL(response.url());
  if (url.origin !== BASE_ORIGIN) return;
  const isPlayback = url.pathname.startsWith("/api/playback/");
  const isHls = url.pathname.startsWith("/api/hls/");
  if (!isPlayback && !isHls && url.pathname !== "/api/system-status") return;
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

async function collectApiSources(
  response: PlaywrightResponse,
  tracker: RosterTracker
): Promise<void> {
  if (!response.url().includes("/api/playback/") || !response.ok()) return;
  try {
    const payload = (await response.json()) as { sources?: unknown[] };
    const url = new URL(response.url());
    if (
      url.searchParams.get("refresh") !== "1" &&
      url.searchParams.get("fast") !== "1" &&
      url.searchParams.get("prefetch") !== "1"
    ) {
      tracker.fullResponseCount += 1;
    }
    for (const raw of payload.sources || []) {
      if (!raw || typeof raw !== "object") continue;
      const source = raw as Record<string, unknown>;
      if (typeof source.id !== "string" || typeof source.provider !== "string") {
        continue;
      }
      tracker.sources.set(source.id, {
        id: source.id,
        provider: source.provider,
        verified: typeof source.verified === "boolean" ? source.verified : null,
        probeOk:
          source.probe &&
          typeof source.probe === "object" &&
          typeof (source.probe as Record<string, unknown>).ok === "boolean"
            ? ((source.probe as Record<string, unknown>).ok as boolean)
            : null,
        compat: typeof source.compat === "string" ? source.compat : null,
        container:
          typeof source.container === "string" ? source.container : null,
      });
    }
  } catch {
    // The player itself surfaces malformed playback responses.
  }
}

function createRosterTracker(): RosterTracker {
  return {
    sources: new Map<string, SafeSource>(),
    fullResponseCount: 0,
    failedSourceIds: new Set<string>(),
  };
}

function observePlayerFailure(tracker: RosterTracker, text: string): void {
  if (!text.startsWith("[playback-failure]")) return;
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) return;
  try {
    const payload = JSON.parse(text.slice(jsonStart)) as {
      sourceId?: unknown;
    };
    if (typeof payload.sourceId === "string") {
      tracker.failedSourceIds.add(payload.sourceId);
    }
  } catch {
    // Malformed diagnostics cannot silently alter the expected roster.
  }
}

function usableApiSourceIds(tracker: RosterTracker): string[] {
  return [...tracker.sources.values()]
    .filter(
      (source) =>
        source.verified !== false &&
        source.probeOk !== false &&
        source.compat !== "safari" &&
        source.container !== "mkv" &&
        source.container !== "webm" &&
        !tracker.failedSourceIds.has(source.id)
    )
    .map((source) => source.id);
}

function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function auditApiContract(viewport: ViewportName): void {
  const observed = apiResponses.filter((item) => item.viewport === viewport);
  const statusPolls = observed.filter(
    (item) => item.path === "/api/system-status"
  );
  record(
    viewport,
    "normal playback does not poll admin system status",
    statusPolls.length === 0,
    statusPolls.length ? `${statusPolls.length} unexpected request(s)` : undefined
  );
  const playbackFailures = observed.filter(
    (item) =>
      (item.path.startsWith("/api/playback/") ||
        item.path.startsWith("/api/hls/")) &&
      (item.status === 403 ||
        item.status === 428 ||
        item.status === 429 ||
        item.status >= 500)
  );
  record(
    viewport,
    "playback and media proxy avoid authorization, dead-source, rate-limit, and server errors",
    playbackFailures.length === 0,
    playbackFailures.length
      ? playbackFailures
          .map((item) => `${item.status} ${item.mode || "unknown"} ${item.path}`)
          .join(", ")
      : undefined
  );
}

function sameList(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function decodedQualityHeight(video: VideoState): number | null {
  const longEdge = Math.max(video.width, video.height);
  const shortEdge = Math.min(video.width, video.height);
  if (longEdge >= 3_800 || shortEdge >= 1_800) return 2160;
  if (longEdge >= 2_500 || shortEdge >= 1_400) return 1440;
  if (longEdge >= 1_900 || shortEdge >= 850) return 1080;
  if (longEdge >= 1_200 || shortEdge >= 600) return 720;
  if (longEdge >= 700 || shortEdge >= 400) return 480;
  if (longEdge >= 630 || shortEdge >= 340) return 360;
  if (longEdge >= 560 || shortEdge >= 280) return 320;
  return null;
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

async function waitForRosterEnrichment(
  sourceRows: Locator,
  tracker: RosterTracker,
  viewport: ViewportName
): Promise<{ displayed: string[]; usable: string[] }> {
  const startedAt = Date.now();
  let stableSince = startedAt;
  let fingerprint = "";
  let displayed: string[] = [];
  let usable: string[] = [];

  while (Date.now() - startedAt < ROSTER_TIMEOUT_MS) {
    displayed = await sourceRows.evaluateAll((buttons) =>
      buttons
        .map((button) => button.getAttribute("data-source-id") || "")
        .filter(Boolean)
    );
    usable = usableApiSourceIds(tracker);
    const nextFingerprint = `${[...displayed].sort()}|${[...usable].sort()}`;
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      stableSince = Date.now();
    }
    const elapsedMs = Date.now() - startedAt;
    if (
      tracker.fullResponseCount > 0 &&
      displayed.length > 0 &&
      elapsedMs >= ROSTER_MIN_ENRICHMENT_MS &&
      Date.now() - stableSince >= ROSTER_SETTLE_MS
    ) {
      rosterObservations.push({
        viewport,
        settledMs: elapsedMs,
        usableApiSourceIds: [...usable],
        displayedSourceIds: [...displayed],
      });
      return { displayed, usable };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `roster did not settle; full=${tracker.fullResponseCount}; ` +
      `usable=${usable.join(",") || "none"}; displayed=${displayed.join(",") || "none"}`
  );
}

async function auditSheet(
  page: Page,
  viewport: ViewportName,
  tracker: RosterTracker
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
    .filter({ hasText: /^(?:Auto|4K|1440p|1080p|720p|480p|360p|320p)(?:\s|$)/ });
  const qualityLabels = (await qualityButtons.allTextContents()).map((text) =>
    text.replace(/·.*$/, "").trim()
  );
  record(
    viewport,
    "quality rail is stable from Auto through 320p",
    sameList(qualityLabels, EXPECTED_QUALITIES),
    qualityLabels.join(" | ")
  );

  await dialog.getByRole("tab", { name: "Sources", exact: true }).click();
  const sourceRows = dialog.locator("button[data-source-id]");
  await sourceRows.first().waitFor({ state: "visible", timeout: 45_000 });
  const settled = await waitForRosterEnrichment(
    sourceRows,
    tracker,
    viewport
  );
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
      const source = tracker.sources.get(row.id);
      return source?.verified === false || source?.probeOk === false;
    })
    .map((row) => row.id);
  record(
    viewport,
    "source list contains only real API sources",
    rows.length > 0 &&
      rows.every(
        (row) => row.id && row.provider && tracker.sources.has(row.id)
      ),
    `${rows.length} usable rows`
  );
  record(
    viewport,
    "settled source list matches the usable API roster",
    sameSet(sourceIds, settled.usable),
    `displayed=${sourceIds.join(",")}; usable=${settled.usable.join(",")}`
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

async function exerciseDisplayedSources(
  page: Page,
  viewport: ViewportName,
  sourceIds: string[]
): Promise<void> {
  if (sourceIds.length <= 1) {
    record(
      viewport,
      "every displayed source reaches an advancing frame",
      "skip",
      "only one usable source"
    );
    record(
      viewport,
      "paused source switch remains paused",
      "skip",
      "only one usable source"
    );
    return;
  }

  for (const sourceId of sourceIds) {
    const before = await state(page);
    try {
      const selected =
        before.sourceId === sourceId
          ? await waitForAdvancingVideo(page, sourceId)
          : await selectSource(page, sourceId, true);
      record(
        viewport,
        `displayed source ${sourceId} reaches an advancing frame`,
        selected.currentTime >= Math.max(0, before.currentTime - 8),
        `${before.currentTime.toFixed(1)}s -> ${selected.currentTime.toFixed(1)}s; ` +
          `${selected.width}x${selected.height}`
      );
    } catch (error) {
      record(
        viewport,
        `displayed source ${sourceId} reaches an advancing frame`,
        false,
        safeError(error)
      );
      throw error;
    }
  }

  await page.keyboard.press("k");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && video.paused;
  });
  const pausedBefore = await state(page);
  const returnTarget = sourceIds.find(
    (sourceId) => sourceId !== pausedBefore.sourceId
  );
  if (!returnTarget) throw new Error("no alternate source for paused switch");
  const pausedAfter = await selectSource(page, returnTarget, false);
  record(
    viewport,
    "paused source switch remains paused",
    pausedAfter.paused &&
      pausedAfter.currentTime >= Math.max(0, pausedBefore.currentTime - 8),
    `${pausedBefore.currentTime.toFixed(1)}s -> ${pausedAfter.currentTime.toFixed(1)}s`
  );
}

async function focusedControl(page: Page): Promise<{
  tab: string | null;
  sourceId: string | null;
  quality: string | null;
}> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      tab:
        active?.getAttribute("role") === "tab"
          ? active.textContent?.trim() || null
          : null,
      sourceId: active?.getAttribute("data-source-id") || null,
      quality: active?.getAttribute("data-quality-value") || null,
    };
  });
}

async function openSheetWithRemote(page: Page): Promise<Locator> {
  await showControls(page);
  const settings = page.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  await settings.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Player settings" });
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "tab"
  );
  return dialog;
}

async function auditTvDpad(page: Page, sourceCount: number): Promise<void> {
  const viewport: ViewportName = "tv";
  let dialog = await openSheetWithRemote(page);
  await page.keyboard.press("ArrowLeft");
  const qualityTab = await focusedControl(page);
  record(
    viewport,
    "D-pad traverses from Sources to Quality",
    qualityTab.tab === "Quality",
    qualityTab.tab || "none"
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const firstQuality = await focusedControl(page);
  await page.keyboard.press("ArrowDown");
  const secondQuality = await focusedControl(page);
  record(
    viewport,
    "D-pad traverses enabled quality rows",
    firstQuality.quality != null &&
      secondQuality.quality != null &&
      firstQuality.quality !== secondQuality.quality,
    `${firstQuality.quality || "none"} -> ${secondQuality.quality || "none"}`
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  dialog = await openSheetWithRemote(page);
  await page.keyboard.press("ArrowRight");
  const sourcesTab = await focusedControl(page);
  record(
    viewport,
    "D-pad traverses from Quality to Sources",
    sourcesTab.tab === "Sources",
    sourcesTab.tab || "none"
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const firstSource = await focusedControl(page);
  let secondSource = firstSource;
  if (sourceCount > 1) {
    await page.keyboard.press("ArrowDown");
    secondSource = await focusedControl(page);
  }
  record(
    viewport,
    "D-pad traverses displayed source rows",
    firstSource.sourceId != null &&
      (sourceCount <= 1 ||
        (secondSource.sourceId != null &&
          secondSource.sourceId !== firstSource.sourceId)),
    sourceCount <= 1
      ? firstSource.sourceId || "none"
      : `${firstSource.sourceId || "none"} -> ${secondSource.sourceId || "none"}`
  );
  await page.screenshot({ path: join(OUT_DIR, "tv-dpad-sources.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function runDesktop(
  browser: Browser
): Promise<void> {
  const viewport: ViewportName = "desktop";
  const tracker = createRosterTracker();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    serviceWorkers: "block",
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  page.on("response", async (response) => {
    observeApiResponse(viewport, response);
    await collectApiSources(response, tracker);
  });
  page.on("console", (message) => {
    observePlayerFailure(tracker, message.text());
  });

  let initialProfile: Preferences | null = null;
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
    initialProfile = await preferences(page);
    record(
      viewport,
      "profile exposes an explicit playback default",
      initialProfile.playbackQuality === "auto" ||
        typeof initialProfile.playbackQuality === "number",
      String(initialProfile.playbackQuality)
    );

    const audit = await auditSheet(page, viewport, tracker);
    await exerciseDisplayedSources(page, viewport, audit.sourceIds);

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
    const profilePlayback = await waitForAdvancingVideo(page);
    const profileDialog = await openSheet(page);
    await profileDialog.getByRole("tab", { name: "Quality", exact: true }).click();
    const profileQualityRow = profileDialog.getByRole("button", {
      name: new RegExp(`^${testProfile.playbackQuality}p(?:\\s|$)`),
    });
    const profileQualityText = await profileQualityRow
      .innerText()
      .catch(() => "");
    const effectiveHeight = decodedQualityHeight(profilePlayback);
    const explicitFallback = /unavailable|fallback/i.test(profileQualityText);
    record(
      viewport,
      "profile default changes effective playback or declares a fallback",
      effectiveHeight === testProfile.playbackQuality || explicitFallback,
      `requested ${testProfile.playbackQuality}p, decoded ${
        effectiveHeight == null ? "unknown" : `${effectiveHeight}p`
      }, row "${profileQualityText || "missing"}"`
    );
    await closeSheet(page);
  } catch (error) {
    record(viewport, "desktop Cineby-style player pass completed", false, safeError(error));
  } finally {
    if (initialProfile) {
      try {
        await savePreferences(page, initialProfile);
        const restored = await preferences(page);
        record(
          viewport,
          "profile default is restored after the isolated test",
          restored.playbackQuality === initialProfile.playbackQuality &&
            restored.audioLanguage === initialProfile.audioLanguage,
          String(restored.playbackQuality)
        );
      } catch (error) {
        record(
          viewport,
          "profile default is restored after the isolated test",
          false,
          safeError(error)
        );
      }
    }
    auditApiContract(viewport);
    await context.close();
  }
}

async function runMobile(
  browser: Browser
): Promise<void> {
  const viewport: ViewportName = "mobile";
  const tracker = createRosterTracker();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("response", async (response) => {
    observeApiResponse(viewport, response);
    await collectApiSources(response, tracker);
  });
  page.on("console", (message) => {
    observePlayerFailure(tracker, message.text());
  });
  try {
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    await waitForAdvancingVideo(page);
    await page.waitForTimeout(1_000);
    await auditSheet(page, viewport, tracker);
  } catch (error) {
    record(viewport, "mobile Cineby-style player pass completed", false, safeError(error));
  } finally {
    auditApiContract(viewport);
    await context.close();
  }
}

async function runTv(
  browser: Browser
): Promise<void> {
  const viewport: ViewportName = "tv";
  const tracker = createRosterTracker();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    storageState: STORAGE_STATE,
    baseURL: BASE,
    serviceWorkers: "block",
  });
  await ensureBaseCookieScope(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("response", async (response) => {
    observeApiResponse(viewport, response);
    await collectApiSources(response, tracker);
  });
  page.on("console", (message) => {
    observePlayerFailure(tracker, message.text());
  });
  try {
    await page.goto(WATCH_PATH, { waitUntil: "domcontentloaded" });
    await waitForAdvancingVideo(page);
    await page.waitForTimeout(1_000);
    const audit = await auditSheet(page, viewport, tracker);
    await auditTvDpad(page, audit.sourceIds.length);
  } catch (error) {
    record(viewport, "TV Cineby-style player pass completed", false, safeError(error));
  } finally {
    auditApiContract(viewport);
    await context.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(`Storage state not found: ${STORAGE_STATE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await runDesktop(browser);
    await runMobile(browser);
    await runTv(browser);
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
    apiResponses,
    rosterObservations,
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
