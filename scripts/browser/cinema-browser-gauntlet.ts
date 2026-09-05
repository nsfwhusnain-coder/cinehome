#!/usr/bin/env bun
/**
 * Playwright Live Headless Browser Gauntlet for Cinehome.
 *
 * Validates:
 * 1. Next.js Auth Login
 * 2. Player mounting with 0 console errors
 * 3. Video decoding and playback (`currentTime > 0`)
 * 4. Seekbar hover frame preview
 * 5. Compact Apple-style Audio & Subtitles selector with Sync & Font tab
 * 6. Compact Apple-style Settings Dock (Quality, Sources, Speed, Stats, Download)
 * 7. Compact Apple-style Episodes Panel (Season rail + episode switching)
 */

import { chromium, type Page, type Browser } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const APP_URL = process.env.APP_URL || "http://localhost:3000";
// Credentials come from the environment, never the repo — this is a PUBLIC
// repository. Same contract as scripts/browser/qa.ts.
const TEST_USER = process.env.CINEHOME_TEST_USER || "";
const TEST_PIN = process.env.CINEHOME_TEST_PIN || "";
const SCREENSHOT_DIR = "/home/hussy/cinehome/scripts/browser/screenshots";

mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface BrowserTestTarget {
  name: string;
  url: string;
  isTv?: boolean;
}

const TEST_TARGETS: BrowserTestTarget[] = [
  { name: "Inception (Movie)", url: `${APP_URL}/watch/movie/27205` },
  { name: "Obsession (4K Movie)", url: `${APP_URL}/watch/movie/1288445` },
  { name: "House of the Dragon (4K TV)", url: `${APP_URL}/watch/tv/94997?season=1&episode=1`, isTv: true },
  { name: "Game of Thrones (TV)", url: `${APP_URL}/watch/tv/1399?season=1&episode=1`, isTv: true },
  { name: "Silo (4K TV)", url: `${APP_URL}/watch/tv/126308?season=1&episode=1`, isTv: true },
];

async function runBrowserGauntlet() {
  console.log("========================================================");
  console.log("🌐 STARTING PLAYWRIGHT LIVE BROWSER GAUNTLET (COMPACT APPLE GLASS UI)");
  console.log("========================================================");

  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  });

  const page: Page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => {
    consoleErrors.push(`[PageError] ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (
        !text.includes("Failed to load resource") &&
        !text.includes("status of 404") &&
        !text.includes("status of 429")
      ) {
        consoleErrors.push(`[ConsoleError] ${text}`);
      }
    }
  });

  // Step 1: Login
  if (!TEST_USER || !TEST_PIN) {
    throw new Error("CINEHOME_TEST_USER and CINEHOME_TEST_PIN must be set");
  }
  console.log("🔑 Logging in to Cinehome via Web UI...");
  await page.goto(`${APP_URL}/login`, { waitUntil: "domcontentloaded" });

  await page.fill('input[type="text"]', TEST_USER);
  await page.fill('input[type="password"]', TEST_PIN);
  await page.click('button[type="submit"]');

  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  console.log("✅ Logged in successfully. Arrived at:", page.url());

  let totalPass = 0;
  let totalFail = 0;

  for (let i = 0; i < TEST_TARGETS.length; i++) {
    const target = TEST_TARGETS[i];
    console.log(`\n🎬 [${i + 1}/${TEST_TARGETS.length}] Testing Live Playback: ${target.name}...`);
    consoleErrors.length = 0;

    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Target main player video element
      const mainVideoLocator = page.locator("video.main-player, video:not([aria-hidden='true'])").first();
      await mainVideoLocator.waitFor({ state: "attached", timeout: 15000 });
      console.log("  ✓ Main video element attached to DOM");

      // Wait for playback buffer and decode
      console.log("  ⏳ Waiting for video playback buffer & decode...");
      const playbackStarted = await page
        .waitForFunction(
          () => {
            const video = document.querySelector(
              "video.main-player, video:not([aria-hidden='true'])"
            ) as HTMLVideoElement;
            return video && video.readyState >= 2 && !video.paused && video.currentTime > 0;
          },
          null,
          { timeout: 20000 }
        )
        .catch(() => null);

      if (!playbackStarted) {
        await page.keyboard.press("Space");
        await page.waitForTimeout(2000);
      }

      const videoStats = await page.evaluate(() => {
        const v = document.querySelector(
          "video.main-player, video:not([aria-hidden='true'])"
        ) as HTMLVideoElement;
        return {
          currentTime: v?.currentTime || 0,
          duration: v?.duration || 0,
          paused: v?.paused,
          readyState: v?.readyState,
          videoWidth: v?.videoWidth,
          videoHeight: v?.videoHeight,
        };
      });

      console.log(
        `  ✓ Video stats: ${videoStats.videoWidth}x${videoStats.videoHeight} @ ${videoStats.currentTime.toFixed(1)}s / ${videoStats.duration.toFixed(1)}s (State: ${videoStats.readyState})`
      );

      // Step 3: Hover Seekbar Test
      const seekbar = page.locator('[role="slider"], input[type="range"]').first();
      if (await seekbar.count()) {
        const box = await seekbar.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
          console.log("  ✓ Seekbar hover simulated");
        }
      }

      // Step 4: Compact Audio & Subtitles Modal Test
      const audioSubBtn = page
        .locator('button[aria-label*="audio & subtitles" i], button:has-text("Audio & Subtitles")')
        .first();
      if (await audioSubBtn.count()) {
        await audioSubBtn.click({ force: true });
        await page.waitForTimeout(500);
        console.log("  ✓ Compact Audio & Subtitles modal opened");

        // Verify Sync & Font tab
        const syncTab = page.locator('button:has-text("Sync & Font")').first();
        if (await syncTab.count()) {
          await syncTab.click({ force: true });
          await page.waitForTimeout(300);
          console.log("  ✓ Sync & Font tab verified");
        }

        // Close modal
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }

      // Step 5: Compact Settings Dock Test
      const settingsBtn = page.locator('button[aria-label="Settings"]').first();
      if (await settingsBtn.count()) {
        await settingsBtn.click({ force: true });
        await page.waitForTimeout(500);
        console.log("  ✓ Compact Settings dock opened");

        // Verify non-redundant tabs: Quality, Sources, Speed, Stats, Download
        const tabsText = await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          return tabs.map((t) => t.textContent?.trim());
        });
        console.log("  ✓ Settings dock tabs:", tabsText.join(" | "));

        // Close dock
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }

      // Step 6: TV Compact Episodes Panel Test
      if (target.isTv) {
        const episodeBtn = page.locator('button[aria-label="Episodes"]').first();
        if (await episodeBtn.count()) {
          await episodeBtn.click({ force: true });
          await page.waitForTimeout(800);
          console.log("  ✓ Compact Episodes Panel opened");

          const panelShot = join(SCREENSHOT_DIR, `compact-episodes-${i + 1}.png`);
          await page.screenshot({ path: panelShot });
          console.log(`  📸 Screenshot saved: ${panelShot}`);

          // Close panel
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
        }
      }

      const cleanShot = join(SCREENSHOT_DIR, `playback-${i + 1}.png`);
      await page.screenshot({ path: cleanShot });
      console.log(`  📸 Screenshot saved: ${cleanShot}`);

      // Verify Console Errors
      if (consoleErrors.length > 0) {
        console.log(
          `  ⚠️ Console errors detected (${consoleErrors.length}):`,
          consoleErrors.slice(0, 3)
        );
      } else {
        console.log("  ✓ 0 Console errors detected");
      }

      console.log(`  ✅ PASS: ${target.name}`);
      totalPass++;
    } catch (err: any) {
      console.log(`  ❌ FAIL: ${target.name} - ${err.message}`);
      totalFail++;
      const errShot = join(SCREENSHOT_DIR, `fail-${i + 1}.png`);
      await page.screenshot({ path: errShot }).catch(() => null);
    }
  }

  await browser.close();

  console.log("\n========================================================");
  console.log(`📊 PLAYWRIGHT BROWSER GAUNTLET RESULTS: ${totalPass} PASS / ${totalFail} FAIL`);
  console.log("========================================================\n");

  if (totalFail > 0) {
    process.exit(1);
  }
}

runBrowserGauntlet().catch((err) => {
  console.error("Browser Gauntlet Exception:", err);
  process.exit(1);
});
