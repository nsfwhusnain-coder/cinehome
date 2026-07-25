/**
 * Mint signed URLs for the Cloudflare Worker HLS proxy.
 * Only called after CineHome has authenticated the user (playback API).
 * Worker rejects missing/invalid/expired tokens → no open proxy.
 */

import { createHmac } from "crypto";
import type { HlsSession } from "@/lib/hls-session";
// Note: hls-session imports this module for proxyUrlFor; keep this file free of
// runtime imports from hls-session to avoid circular init issues.

export interface WorkerProxyPayload {
  u: string;
  r: string;
  o: string;
  a: string;
  c: string;
  x: Record<string, string>;
  e: number;
  i: string;
}

/** Token lifetime (seconds). Sliding sessions on home can be longer; Worker hard-caps. */
const TOKEN_TTL_S = 3 * 60 * 60; // 3 hours

/**
 * Worker edge proxy is **opt-in only** (`WORKER_PROXY_ENABLED=1`).
 * Many embed CDNs (Vixsrc, etc.) return 403 from Cloudflare datacenter IPs —
 * home `/api/hls` (residential) works; silent Worker mint breaks all playback.
 */
export function isWorkerProxyEnabled(): boolean {
  const flag = process.env.WORKER_PROXY_ENABLED?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "yes" && flag !== "on") {
    return false;
  }
  const base = process.env.WORKER_PROXY_BASE?.trim();
  const secret = process.env.WORKER_PROXY_SECRET?.trim();
  return Boolean(base && secret);
}

export function getWorkerProxyBase(): string | null {
  if (!isWorkerProxyEnabled()) return null;
  return process.env.WORKER_PROXY_BASE!.trim().replace(/\/$/, "");
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Build a Worker URL that carries signed session headers for one upstream URL.
 * Requires authenticated CineHome user (session.userId).
 */
export function buildWorkerProxyUrl(session: HlsSession, upstream: string): string {
  const base = getWorkerProxyBase();
  const secret = process.env.WORKER_PROXY_SECRET?.trim();
  if (!base || !secret) {
    throw new Error("Worker proxy not configured");
  }

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  // Never mint tokens past the home session expiry
  const sessionExp = Math.floor(session.expiresAt / 1000);
  const e = Math.min(exp, sessionExp);

  const payload: WorkerProxyPayload = {
    u: upstream,
    r: session.referer || "",
    o: session.origin || "",
    a:
      session.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    c: session.cookies || "",
    x: session.extraHeaders || {},
    e,
    i: session.userId,
  };

  const payloadB64 = b64urlJson(payload);
  const sig = signPayload(payloadB64, secret);
  return `${base}/?t=${payloadB64}.${sig}`;
}
