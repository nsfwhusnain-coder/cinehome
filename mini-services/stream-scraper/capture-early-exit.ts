/**
 * Pure early-exit decision for Playwright network-intercept waits.
 * Stop burning captureWaitMs once enough non-poison streams have landed.
 */

import { isPoisonStreamUrl } from "./poison-url";

/** Minimum good HLS captures before settle-based early exit. */
export const EARLY_EXIT_MIN_HLS = 1;
/** Immediate exit once this many good captures exist (no settle wait). */
export const EARLY_EXIT_TARGET_CAPTURES = 3;
/** After first good stream, wait this much more max for siblings. */
export const EARLY_EXIT_SETTLE_MS = 1_500;
/** Poll interval while waiting for network captures. */
export const EARLY_EXIT_POLL_MS = 200;

export interface EarlyExitCapture {
  url: string;
  label?: string;
}

function labelLower(label?: string): string {
  return (label || "").toLowerCase();
}

/** True when capture looks like HLS (path or label). */
export function isHlsEarlyCapture(url: string, label?: string): boolean {
  const lower = url.toLowerCase();
  const lbl = labelLower(label);
  return lower.includes(".m3u8") || lbl === "hls" || lbl.includes("hls");
}

/**
 * True for a usable stream URL for early-exit counting:
 * .m3u8 / HLS label, or .mp4 (and DASH .mpd), non-poison.
 */
export function isGoodEarlyCapture(url: string, label?: string): boolean {
  if (!url || typeof url !== "string") return false;
  if (isPoisonStreamUrl(url)) return false;
  const lower = url.toLowerCase();
  const lbl = labelLower(label);
  if (isHlsEarlyCapture(url, label)) return true;
  if (lower.includes(".mpd") || lbl === "dash") return true;
  if (lower.includes(".mp4") || lbl === "mp4" || lbl === "direct") return true;
  return false;
}

export function countGoodEarlyCaptures(captures: EarlyExitCapture[]): number {
  let n = 0;
  for (const c of captures) {
    if (isGoodEarlyCapture(c.url, c.label)) n += 1;
  }
  return n;
}

function countGoodHls(captures: EarlyExitCapture[]): number {
  let n = 0;
  for (const c of captures) {
    if (isGoodEarlyCapture(c.url, c.label) && isHlsEarlyCapture(c.url, c.label)) {
      n += 1;
    }
  }
  return n;
}

/**
 * Whether we should stop waiting for more network traffic.
 * - past hard deadline → true
 * - goodCount ≥ EARLY_EXIT_TARGET_CAPTURES → true (immediate)
 * - ≥ EARLY_EXIT_MIN_HLS good HLS + settle elapsed → true
 * - only MP4s: 1 solid after settle, or target captures
 * - no good captures → false (unless past deadline)
 */
export function shouldEarlyExitWait(opts: {
  captures: EarlyExitCapture[];
  firstGoodAtMs: number | null;
  nowMs: number;
  hardDeadlineMs: number;
}): boolean {
  const { captures, firstGoodAtMs, nowMs, hardDeadlineMs } = opts;

  if (nowMs >= hardDeadlineMs) return true;

  const goodCount = countGoodEarlyCaptures(captures);
  if (goodCount === 0) return false;

  if (goodCount >= EARLY_EXIT_TARGET_CAPTURES) return true;

  if (firstGoodAtMs == null) return false;
  const settled = nowMs - firstGoodAtMs >= EARLY_EXIT_SETTLE_MS;
  if (!settled) return false;

  const hlsCount = countGoodHls(captures);
  if (hlsCount >= EARLY_EXIT_MIN_HLS) return true;

  // Only MP4s (or non-HLS): one solid after settle is enough.
  return goodCount >= 1;
}
