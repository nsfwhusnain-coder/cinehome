#!/usr/bin/env bun
/**
 * Live headed tour of Absolute Cinema: home + several movies/shows.
 * Captures playback roster quality and a small skip on each title.
 *
 *   cd /Users/husnainali/cinehome
 *   source ~/.grok/secrets/cinehome.env
 *   HEADED=1 bun scripts/browser/live-quality-tour.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const ROOT = resolve(import.meta.dir, "../..");
const OUT_DIR = process.env.OUT_DIR || join(ROOT, ".browser-qa");
const STATE_PATH = join(OUT_DIR, "storage-state.json");
const REPORT_PATH = join(OUT_DIR, "quality-tour.json");

function loadSecretsFile(): void {
  const p = join(homedir(), ".grok/secrets/cinehome.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env) || !process.env[k]) process.env[k] = v;
  }
}
loadSecretsFile();

const BASE = (process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445").replace(
  /\/$/,
  ""
);
const USER = process.env.CINEHOME_TEST_USER || "grokqa";
const PIN = process.env.CINEHOME_TEST_PIN || "";
const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";

mkdirSync(OUT_DIR, { recursive: true });

const TITLES = [
  { name: "Fight Club", path: "/watch/movie/550", api: "/api/playback/movie/550" },
  { name: "Barbie", path: "/watch/movie/346698", api: "/api/playback/movie/346698" },
  { name: "Dune Part Two", path: "/watch/movie/693134", api: "/api/playback/movie/693134" },
  {
    name: "Breaking Bad S1E1",
    path: "/watch/tv/1396?season=1&episode=1",
    api: "/api/playback/tv/1396?season=1&episode=1",
  },
  {
    name: "Squid Game S1E1",
    path: "/watch/tv/93405?season=1&episode=1",
    api: "/api/playback/tv/93405?season=1&episode=1",
  },
] as const;

type SourceRow = {
  id?: string;
  label?: string;
  provider?: string;
  quality?: string;
  maxHeight?: number;
  bitrateBps?: number;
  origin?: string;
  container?: string;
  codec?: string;
  audioLanguage?: string;
  verified?: boolean;
};

function summarizeSources(sources: SourceRow[] | undefined) {
  return (sources ?? []).slice(0, 12).map((s) => ({
    label: s.label,
    provider: s.provider,
    height: s.maxHeight,
    bitrateMbps: s.bitrateBps ? Math.round(s.bitrateBps / 100_000) / 10 : null,
    origin: s.origin,
    container: s.container,
    codec: s.codec,
    lang: s.audioLanguage,
  }));
}

async function ensureLogin(page: Page): Promise<void> {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const progress = await page.request.get(`${BASE}/api/progress`);
  if (progress.ok()) {
    console.log("SESSION already authenticated");
    return;
  }
  if (!PIN) throw new Error("CINEHOME_TEST_PIN missing");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#signin-name").fill(USER);
  await page.locator("#signin-pin").fill(PIN);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  const after = await page.request.get(`${BASE}/api/progress`);
  if (!after.ok()) throw new Error("Login failed");
  console.log(`LOGIN ok as ${USER}`);
}

async function videoSnapshot(page: Page) {
  return page.evaluate(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (!v) return { present: false };
    return {
      present: true,
      paused: v.paused,
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : 0,
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      seeking: v.seeking,
      srcHost: (() => {
        try {
          return new URL(v.currentSrc || v.src, location.origin).pathname.slice(0, 40);
        } catch {
          return (v.currentSrc || "").slice(0, 40);
        }
      })(),
    };
  });
}

async function waitForVideo(page: Page, timeoutMs = 28_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await videoSnapshot(page);
    if (snap.present && (snap.readyState ?? 0) >= 2 && (snap.videoHeight ?? 0) > 0) {
      return snap;
    }
    await page.waitForTimeout(800);
  }
  return videoSnapshot(page);
}

async function openSettings(page: Page): Promise<boolean> {
  await page.mouse.move(700, 500);
  await page.locator("video").first().click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(400);
  const settings = page.getByRole("button", { name: "Settings" }).first();
  if ((await settings.count()) === 0) return false;
  await settings.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const dock = page.locator('[aria-label="Player settings"]');
  return (await dock.count()) > 0;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: HEADED ? 80 : 0,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: existsSync(STATE_PATH) ? STATE_PATH : undefined,
    baseURL: BASE,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);

  const report: Record<string, unknown>[] = [];
  try {
    await ensureLogin(page);
    await context.storageState({ path: STATE_PATH });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page
      .waitForSelector("img[src*='image.tmdb.org'], a[href*='/movie/']", { timeout: 20_000 })
      .catch(() => undefined);
    const homeShot = join(OUT_DIR, `tour-home.png`);
    await page.screenshot({ path: homeShot, fullPage: false });
    console.log("SCREENSHOT", homeShot);

    for (const title of TITLES) {
      console.log(`\n=== ${title.name} ===`);
      const lastPlayback: { body?: unknown; status?: number } = {};
      const onResponse = async (res: import("playwright").Response) => {
        if (!res.url().includes("/api/playback/")) return;
        if (res.request().method() !== "GET") return;
        try {
          lastPlayback.status = res.status();
          lastPlayback.body = await res.json();
        } catch {
          /* ignore */
        }
      };
      page.on("response", onResponse);

      await page.goto(`${BASE}${title.path}`, { waitUntil: "domcontentloaded" });
      const video = await waitForVideo(page);
      const beforeSeek = { ...(await videoSnapshot(page)) };

      let seekMs: number | null = null;
      let seekTarget = 0;
      let seekNotice: string | null = null;
      let afterSeek = beforeSeek;
      if (beforeSeek.present && (beforeSeek.readyState ?? 0) >= 2) {
        const duration =
          beforeSeek.duration && beforeSeek.duration > 60 ? beforeSeek.duration : 0;
        seekTarget = duration > 0 ? duration * 0.5 : 0;
        await page.mouse.move(720, 480);
        await page.locator("video").first().click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(400);
        const slider = page.getByRole("slider", { name: "Seek" });
        const t0 = Date.now();
        if (seekTarget > 0 && (await slider.count()) > 0) {
          const box = await slider.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
          }
        } else if (seekTarget > 0) {
          await page.evaluate((target) => {
            const v = document.querySelector("video") as HTMLVideoElement | null;
            if (!v) return;
            v.currentTime = target;
          }, seekTarget);
        }
        const deadline = Date.now() + 50_000;
        while (Date.now() < deadline) {
          const notice = await page
            .locator("text=/Opening that position|prepar/i")
            .first()
            .innerText()
            .catch(() => null);
          if (notice) seekNotice = notice;
          const snap = await videoSnapshot(page);
          afterSeek = snap;
          const closeEnough =
            snap.present &&
            !snap.seeking &&
            (snap.readyState ?? 0) >= 2 &&
            (seekTarget === 0 || (snap.currentTime ?? 0) >= seekTarget * 0.85);
          if (closeEnough) {
            seekMs = Date.now() - t0;
            break;
          }
          await page.waitForTimeout(250);
        }
        if (seekMs == null) seekMs = Date.now() - t0;
        afterSeek = await videoSnapshot(page);
      }

      const dockOpen = await openSettings(page);
      if (dockOpen) {
        await page.getByRole("tab", { name: "Server" }).click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
      const shot = join(
        OUT_DIR,
        `tour-${title.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`
      );
      await page.screenshot({ path: shot, fullPage: false });
      console.log("SCREENSHOT", shot);

      const body = lastPlayback.body as
        | { sources?: SourceRow[]; streamUrl?: string; status?: string; message?: string }
        | undefined;
      const row = {
        title: title.name,
        path: title.path,
        http: lastPlayback.status ?? null,
        playbackStatus: body?.status ?? null,
        message: body?.message ?? null,
        sourceCount: body?.sources?.length ?? 0,
        sources: summarizeSources(body?.sources),
        video: await videoSnapshot(page),
        firstFrame: video,
        seekTarget,
        seekNotice,
        seekMs,
        afterSeek,
        dockOpen,
        shot,
      };
      report.push(row);
      console.log(
        JSON.stringify(
          {
            title: row.title,
            sources: row.sourceCount,
            video: row.video,
            seekTarget: row.seekTarget,
            seekMs: row.seekMs,
            seekNotice: row.seekNotice,
            afterSeek: row.afterSeek,
            top: row.sources.slice(0, 5),
          },
          null,
          2
        )
      );
      page.off("response", onResponse);
    }

    writeFileSync(REPORT_PATH, JSON.stringify({ at: new Date().toISOString(), base: BASE, report }, null, 2));
    console.log("REPORT", REPORT_PATH);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("TOUR_FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
