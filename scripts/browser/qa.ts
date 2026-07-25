#!/usr/bin/env bun
/**
 * CineHome browser QA — see + interact with the live site.
 *
 * Loads secrets from ~/.grok/secrets/cinehome.env (or process env).
 * Screenshots → .browser-qa/ (gitignored). Agent reads those images.
 *
 * Usage:
 *   source ~/.grok/secrets/cinehome.env
 *   bun scripts/browser/qa.ts screenshot [path|/] [name]
 *   bun scripts/browser/qa.ts login
 *   bun scripts/browser/qa.ts open <path>
 *   bun scripts/browser/qa.ts click <selector>
 *   bun scripts/browser/qa.ts fill <selector> <text>
 *   bun scripts/browser/qa.ts flow smoke
 *   bun scripts/browser/qa.ts flow home
 *   bun scripts/browser/qa.ts flow watch-movie [tmdbId]
 *   bun scripts/browser/qa.ts eval <js>
 *
 * Env:
 *   CINEHOME_BASE_URL   default http://100.89.184.84:4445
 *   CINEHOME_TEST_USER  login name
 *   CINEHOME_TEST_PIN   login PIN
 *   HEADED=1            show browser window
 *   SLOW_MO=ms          slow actions for human watch
 *   MOBILE=1            iPhone-ish viewport
 *   OUT_DIR             screenshot dir (default .browser-qa)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const ROOT = resolve(import.meta.dir, "../..");
const OUT_DIR = process.env.OUT_DIR || join(ROOT, ".browser-qa");
const STATE_PATH = join(OUT_DIR, "storage-state.json");
const LAST_META = join(OUT_DIR, "last-run.json");

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

const BASE = (process.env.CINEHOME_BASE_URL || "http://100.89.184.84:4445").replace(/\/$/, "");
const USER = process.env.CINEHOME_TEST_USER || "grokqa";
const PIN = process.env.CINEHOME_TEST_PIN || "";
const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";
const SLOW_MO = Number(process.env.SLOW_MO || (HEADED ? "80" : "0"));
const MOBILE = process.env.MOBILE === "1";

mkdirSync(OUT_DIR, { recursive: true });

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function writeMeta(data: Record<string, unknown>): void {
  writeFileSync(LAST_META, JSON.stringify({ at: new Date().toISOString(), base: BASE, ...data }, null, 2));
}

async function launch(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: Number.isFinite(SLOW_MO) ? SLOW_MO : 0,
  });
  const context = await browser.newContext({
    viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 CineHomeQA/1.0",
    storageState: existsSync(STATE_PATH) ? STATE_PATH : undefined,
    baseURL: BASE,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { browser, context, page };
}

async function shot(page: Page, name: string): Promise<string> {
  const file = join(OUT_DIR, `${stamp()}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`SCREENSHOT ${file}`);
  return file;
}

/** Wait for hero/rail content so we don't screenshot empty shells. */
async function waitForCatalog(page: Page): Promise<void> {
  await page
    .waitForSelector(
      "img[src*='image.tmdb.org'], [data-testid='movie-card'], a[href*='/movie/'], a[href*='/tv/'], video",
      { timeout: 25_000 }
    )
    .catch(() => {
      /* still screenshot — empty state is useful signal */
    });
  await page.waitForTimeout(800);
}

/** Session is real only if a protected API accepts us (nav chrome is public). */
async function isAuthenticated(page: Page): Promise<boolean> {
  try {
    const res = await page.request.get(`${BASE}/api/progress`, { timeout: 10_000 });
    return res.ok();
  } catch {
    return false;
  }
}

/** Parse one Set-Cookie header into a Playwright cookie for BASE host. */
function cookieFromSetCookie(raw: string, baseUrl: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
} | null {
  const parts = raw.split(";").map((p) => p.trim());
  const [nv, ...attrs] = parts;
  if (!nv) return null;
  const eq = nv.indexOf("=");
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return null;
  const host = new URL(baseUrl).hostname;
  let path = "/";
  let expires = -1;
  let httpOnly = false;
  let secure = false;
  let sameSite: "Lax" | "Strict" | "None" = "Lax";
  for (const a of attrs) {
    const low = a.toLowerCase();
    if (low.startsWith("path=")) path = a.slice(5) || "/";
    else if (low.startsWith("expires=")) {
      const t = Date.parse(a.slice(8));
      if (Number.isFinite(t)) expires = Math.floor(t / 1000);
    } else if (low.startsWith("max-age=")) {
      const sec = Number(a.slice(8));
      if (Number.isFinite(sec)) expires = Math.floor(Date.now() / 1000) + sec;
    } else if (low === "httponly") httpOnly = true;
    else if (low === "secure") secure = true;
    else if (low.startsWith("samesite=")) {
      const v = a.slice(9).toLowerCase();
      if (v === "strict") sameSite = "Strict";
      else if (v === "none") sameSite = "None";
      else sameSite = "Lax";
    }
  }
  return { name, value, domain: host, path, expires, httpOnly, secure, sameSite };
}

/**
 * Log in via NextAuth credentials using Bun fetch + cookie jar, then inject
 * session cookies into the Playwright context.
 */
async function bootstrapSessionCookies(context: BrowserContext): Promise<void> {
  if (!PIN) throw new Error("CINEHOME_TEST_PIN missing");
  const jar = new Map<string, string>();
  const applySetCookie = (headers: Headers) => {
    // Bun/fetch may expose getSetCookie(); fall back to raw header.
    const multi =
      typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : [];
    const raw = multi.length ? multi : [headers.get("set-cookie") || ""].filter(Boolean);
    for (const line of raw) {
      // Multiple cookies may be comma-joined; split carefully on ", " before name=
      for (const piece of line.split(/,(?=\s*[^;=]+=)/)) {
        const c = cookieFromSetCookie(piece.trim(), BASE);
        if (c) jar.set(c.name, piece.trim());
      }
    }
  };
  const cookieHeader = () =>
    [...jar.entries()]
      .map(([name, raw]) => {
        const c = cookieFromSetCookie(raw, BASE);
        return c ? `${c.name}=${c.value}` : "";
      })
      .filter(Boolean)
      .join("; ");

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, {
    headers: { cookie: cookieHeader() },
  });
  applySetCookie(csrfRes.headers);
  const csrfJson = (await csrfRes.json()) as { csrfToken?: string };
  if (!csrfJson.csrfToken) throw new Error("CSRF token missing");

  const body = new URLSearchParams({
    csrfToken: csrfJson.csrfToken,
    name: USER,
    pin: PIN,
    callbackUrl: `${BASE}/`,
    json: "true",
  });
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(loginRes.headers);

  const cookies = [...jar.values()]
    .map((raw) => cookieFromSetCookie(raw, BASE))
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (!cookies.some((c) => c.name.includes("session-token"))) {
    throw new Error("No session-token cookie after credentials login");
  }
  await context.addCookies(cookies);
}

async function ensureLogin(page: Page, context: BrowserContext): Promise<void> {
  // Warm jar from storageState (set at context creation) then verify.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  if (await isAuthenticated(page)) {
    console.log("SESSION already authenticated");
    return;
  }

  if (!PIN) {
    throw new Error("CINEHOME_TEST_PIN missing — set ~/.grok/secrets/cinehome.env");
  }

  // Prefer NextAuth credentials via fetch + cookie jar (not page.request —
  // Playwright APIRequestContext throws on relative Set-Cookie response URLs
  // from this NextAuth setup). Form fill() is a fallback only.
  try {
    await bootstrapSessionCookies(context);
  } catch (e) {
    console.log("CSRF cookie bootstrap failed:", e instanceof Error ? e.message : e);
  }

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  if (!(await isAuthenticated(page))) {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.locator("#signin-name").click();
    await page.locator("#signin-name").pressSequentially(USER, { delay: 15 });
    await page.locator("#signin-pin").click();
    await page.locator("#signin-pin").pressSequentially(PIN, { delay: 15 });
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  if (!(await isAuthenticated(page))) {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`Login failed for ${USER}. Body snippet: ${body.slice(0, 200)}`);
  }
  await context.storageState({ path: STATE_PATH });
  console.log(`LOGIN ok as ${USER}; state → ${STATE_PATH}`);
}

async function cmdScreenshot(pathArg: string, name?: string): Promise<void> {
  const { browser, context, page } = await launch();
  try {
    await ensureLogin(page, context);
    const path = pathArg.startsWith("http") ? pathArg : pathArg || "/";
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForCatalog(page);
    const file = await shot(page, name || path.replace(/\W+/g, "_").slice(0, 40) || "page");
    writeMeta({ cmd: "screenshot", path, file, url: page.url(), title: await page.title() });
  } finally {
    await browser.close();
  }
}

async function cmdOpen(pathArg: string): Promise<void> {
  const { browser, context, page } = await launch();
  try {
    await ensureLogin(page, context);
    await page.goto(pathArg || "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const file = await shot(page, "open");
    writeMeta({
      cmd: "open",
      url: page.url(),
      title: await page.title(),
      file,
      textSample: (await page.locator("body").innerText()).slice(0, 500),
    });
  } finally {
    await browser.close();
  }
}

async function cmdClick(selector: string): Promise<void> {
  const { browser, context, page } = await launch();
  try {
    await ensureLogin(page, context);
    // stay on current home if state restored — go home first
    if (page.url() === "about:blank") await page.goto("/");
    await page.locator(selector).first().click({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    const file = await shot(page, "click");
    writeMeta({ cmd: "click", selector, url: page.url(), file });
  } finally {
    await browser.close();
  }
}

async function cmdFill(selector: string, text: string): Promise<void> {
  const { browser, context, page } = await launch();
  try {
    await ensureLogin(page, context);
    if (page.url() === "about:blank") await page.goto("/");
    await page.locator(selector).first().fill(text);
    const file = await shot(page, "fill");
    writeMeta({ cmd: "fill", selector, url: page.url(), file });
  } finally {
    await browser.close();
  }
}

async function cmdEval(js: string): Promise<void> {
  const { browser, context, page } = await launch();
  try {
    await ensureLogin(page, context);
    if (page.url() === "about:blank") await page.goto("/");
    const result = await page.evaluate(js);
    console.log("EVAL", JSON.stringify(result, null, 2));
    writeMeta({ cmd: "eval", result });
  } finally {
    await browser.close();
  }
}

async function flowHome(): Promise<void> {
  const { browser, context, page } = await launch();
  const files: string[] = [];
  try {
    await ensureLogin(page, context);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForCatalog(page);
    files.push(await shot(page, "home-fold"));
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(600);
    files.push(await shot(page, "home-scroll"));
    writeMeta({
      cmd: "flow-home",
      url: page.url(),
      title: await page.title(),
      files,
      h1: await page.locator("h1, [class*='hero']").first().innerText().catch(() => null),
    });
  } finally {
    await browser.close();
  }
}

async function flowSmoke(): Promise<void> {
  const { browser, context, page } = await launch();
  const files: string[] = [];
  const notes: string[] = [];
  try {
    await ensureLogin(page, context);
    files.push(await shot(page, "01-after-login"));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    files.push(await shot(page, "02-home"));

    await page.goto("/movies", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    files.push(await shot(page, "03-movies"));

    await page.goto("/shows", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    files.push(await shot(page, "04-shows"));

    await page.goto("/search", { waitUntil: "domcontentloaded" });
    const searchInput = page.locator('input[type="search"], input[placeholder*="Search"], input[name="q"]').first();
    if ((await searchInput.count()) > 0) {
      await searchInput.fill("witcher");
      await page.waitForTimeout(1500);
    }
    files.push(await shot(page, "05-search"));

    // Detail: Fight Club (stable TMDB id)
    await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    files.push(await shot(page, "06-movie-detail"));

    // Watch page (playback resolve may take time)
    await page.goto("/watch/movie/550", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    files.push(await shot(page, "07-watch-loading-or-play"));
    // Wait longer for stream
    await page.waitForTimeout(8000);
    files.push(await shot(page, "08-watch-later"));

    const hasVideo = (await page.locator("video").count()) > 0;
    notes.push(hasVideo ? "video element present" : "no video element yet");
    const errText = await page.locator("text=/failed|error|No stream|Retry/i").first().innerText().catch(() => null);
    if (errText) notes.push(`error chrome: ${errText.slice(0, 120)}`);

    writeMeta({ cmd: "flow-smoke", files, notes, url: page.url() });
    console.log("SMOKE notes:", notes.join(" | ") || "ok");
  } finally {
    await browser.close();
  }
}

async function flowWatchMovie(tmdbId: string): Promise<void> {
  const { browser, context, page } = await launch();
  const files: string[] = [];
  try {
    await ensureLogin(page, context);
    await page.goto(`/watch/movie/${tmdbId}`, { waitUntil: "domcontentloaded" });
    for (const [i, wait] of [2, 6, 12].entries()) {
      await page.waitForTimeout(wait * 1000);
      files.push(await shot(page, `watch-${tmdbId}-${i}`));
    }
    const videoState = await page.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (!v) return { present: false };
      return {
        present: true,
        paused: v.paused,
        currentTime: v.currentTime,
        duration: v.duration,
        readyState: v.readyState,
        error: v.error?.message ?? null,
      };
    });
    writeMeta({ cmd: "flow-watch-movie", tmdbId, files, videoState, url: page.url() });
    console.log("VIDEO", JSON.stringify(videoState));
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(`CineHome browser QA
  base=${BASE} user=${USER} headed=${HEADED}
  commands: screenshot | login | open | click | fill | eval | flow
  flows: smoke | home | watch-movie [id]`);
    process.exit(0);
  }

  console.log(`QA base=${BASE} user=${USER} headed=${HEADED} out=${OUT_DIR}`);

  if (cmd === "login") {
    const { browser, context, page } = await launch();
    try {
      // force re-login
      if (existsSync(STATE_PATH)) {
        // ignore — ensureLogin will use or re-auth
      }
      await ensureLogin(page, context);
      await shot(page, "login-ok");
      writeMeta({ cmd: "login", url: page.url() });
    } finally {
      await browser.close();
    }
    return;
  }

  if (cmd === "screenshot") {
    await cmdScreenshot(rest[0] || "/", rest[1]);
    return;
  }
  if (cmd === "open") {
    await cmdOpen(rest[0] || "/");
    return;
  }
  if (cmd === "click") {
    if (!rest[0]) throw new Error("click requires selector");
    await cmdClick(rest[0]);
    return;
  }
  if (cmd === "fill") {
    if (!rest[0] || rest[1] === undefined) throw new Error("fill requires selector and text");
    await cmdFill(rest[0], rest.slice(1).join(" "));
    return;
  }
  if (cmd === "eval") {
    await cmdEval(rest.join(" ") || "document.title");
    return;
  }
  if (cmd === "flow") {
    const flow = rest[0] || "smoke";
    if (flow === "smoke") await flowSmoke();
    else if (flow === "home") await flowHome();
    else if (flow === "watch-movie") await flowWatchMovie(rest[1] || "550");
    else throw new Error(`Unknown flow: ${flow}`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error("QA_FAIL", e instanceof Error ? e.message : e);
  writeMeta({ error: String(e) });
  process.exit(1);
});
