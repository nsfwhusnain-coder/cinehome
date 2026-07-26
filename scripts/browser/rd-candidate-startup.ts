#!/usr/bin/env bun
/**
 * Measure real Chromium first-frame startup for cached native Real-Debrid
 * candidates without printing signed media URLs.
 *
 * Run inside the production image:
 *   IMDB_IDS=tt0137523,tt2866360 bun scripts/browser/rd-candidate-startup.ts
 */
import { chromium } from "playwright";
import { db } from "../../src/lib/db";

const imdbIds = (process.env.IMDB_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.STARTUP_TIMEOUT_MS || 20_000);

if (!imdbIds.length) {
  throw new Error("IMDB_IDS is required");
}

const rows = await db.cachedStream.findMany({
  where: {
    imdbId: { in: imdbIds },
    provider: "realdebrid",
    quality: { startsWith: "native-" },
    expiresAt: { gt: new Date() },
  },
  select: {
    imdbId: true,
    mediaType: true,
    season: true,
    episode: true,
    quality: true,
    title: true,
    url: true,
    codec: true,
    container: true,
    compat: true,
  },
  orderBy: [
    { imdbId: "asc" },
    { season: "asc" },
    { episode: "asc" },
    { quality: "asc" },
  ],
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
try {
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (
      row.compat !== "native" ||
      (row.container && row.container !== "mp4" && row.container !== "mov") ||
      row.codec === "hevc"
    ) {
      results.push({
        imdbId: row.imdbId,
        mediaType: row.mediaType,
        season: row.season,
        episode: row.episode,
        slot: row.quality,
        skipped: "not_native_playable",
        codec: row.codec,
        container: row.container,
      });
      continue;
    }

    const page = await context.newPage();
    const started = performance.now();
    await page.setContent('<video muted autoplay playsinline preload="auto"></video>');
    await page.evaluate((url) => {
      const video = document.querySelector("video") as HTMLVideoElement;
      video.src = url;
      void video.play().catch(() => undefined);
    }, row.url);

    let sample:
      | {
          elapsedMs: number;
          width: number;
          height: number;
          duration: number | null;
          currentTime: number;
          readyState: number;
          mediaError: number | null;
        }
      | undefined;
    while (performance.now() - started < timeoutMs) {
      const state = await page.evaluate(() => {
        const video = document.querySelector("video") as HTMLVideoElement;
        return {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          currentTime: video.currentTime,
          readyState: video.readyState,
          paused: video.paused,
          mediaError: video.error?.code ?? null,
        };
      });
      if (
        state.width > 0 &&
        state.height > 0 &&
        state.readyState >= 2 &&
        state.currentTime > 0.1 &&
        !state.paused
      ) {
        sample = {
          elapsedMs: Math.round(performance.now() - started),
          width: state.width,
          height: state.height,
          duration: state.duration,
          currentTime: state.currentTime,
          readyState: state.readyState,
          mediaError: state.mediaError,
        };
        break;
      }
      if (state.mediaError) {
        sample = {
          elapsedMs: Math.round(performance.now() - started),
          width: state.width,
          height: state.height,
          duration: state.duration,
          currentTime: state.currentTime,
          readyState: state.readyState,
          mediaError: state.mediaError,
        };
        break;
      }
      await page.waitForTimeout(100);
    }

    results.push({
      imdbId: row.imdbId,
      mediaType: row.mediaType,
      season: row.season,
      episode: row.episode,
      slot: row.quality,
      codec: row.codec,
      container: row.container,
      success: Boolean(
        sample &&
          sample.mediaError == null &&
          sample.width > 0 &&
          sample.currentTime > 0.1
      ),
      ...(sample ?? {
        elapsedMs: timeoutMs,
        width: 0,
        height: 0,
        duration: null,
        currentTime: 0,
        readyState: 0,
        mediaError: null,
      }),
    });
    await page.close();
  }
  console.log(JSON.stringify({ timeoutMs, results }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await db.$disconnect();
}
