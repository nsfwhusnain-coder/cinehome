/**
 * One-off TTFF probe for Absolute Cinema watch page.
 * Usage: bun scripts/browser/ttff-check.ts [tmdbId]
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445";
const USER = process.env.CINEHOME_TEST_USER || "grokqa";
const PIN = process.env.CINEHOME_TEST_PIN || "";
const OUT = ".browser-qa";
const tmdbId = process.argv[2] || "550";

fs.mkdirSync(OUT, { recursive: true });

async function main(): Promise<void> {
  const statePath = path.join(OUT, "storage-state.json");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    baseURL: BASE,
  });
  const page = await context.newPage();
  const net: string[] = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/playback") || u.includes("/api/hls") || u.includes(".m3u8") || u.includes(".mp4")) {
      net.push(`${r.status()} ${u.slice(0, 140)}`);
    }
  });

  // Auth gate: protected API must accept session.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  let authed = false;
  try {
    const res = await page.request.get(`${BASE}/api/progress`, { timeout: 10_000 });
    authed = res.ok();
  } catch {
    authed = false;
  }
  if (!authed) {
    if (!PIN) throw new Error("CINEHOME_TEST_PIN missing");
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator("#signin-name").fill(USER);
    await page.locator("#signin-pin").fill(PIN);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForTimeout(2000);
    await context.storageState({ path: statePath });
    const res2 = await page.request.get(`${BASE}/api/progress`, { timeout: 10_000 });
    if (!res2.ok()) throw new Error(`login failed status=${res2.status()}`);
  }
  console.log("auth ok", page.url());

  const t0 = Date.now();
  await page.goto(`/watch/movie/${tmdbId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  console.log("watch url", page.url());

  async function snap(label: string): Promise<void> {
    const st = await page.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 280);
      return {
        t: v?.currentTime ?? null,
        rs: v?.readyState ?? null,
        paused: v?.paused ?? null,
        dur: v && Number.isFinite(v.duration) ? v.duration : null,
        err: v?.error?.code ?? null,
        txt,
      };
    });
    const file = path.join(OUT, `ttff-${tmdbId}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(
      label,
      "ms",
      Date.now() - t0,
      "t",
      st.t,
      "rs",
      st.rs,
      "paused",
      st.paused,
      "dur",
      st.dur,
      "err",
      st.err,
      "txt",
      st.txt.slice(0, 140)
    );
  }

  await snap("t0");
  for (const w of [4, 4, 4, 6, 8, 10]) {
    await page.waitForTimeout(w * 1000);
    await page.locator("video").click({ force: true }).catch(() => {});
    await snap(`w${w}`);
  }

  console.log("--- net ---");
  for (const line of net.slice(0, 60)) console.log(line);
  console.log("net count", net.length);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
