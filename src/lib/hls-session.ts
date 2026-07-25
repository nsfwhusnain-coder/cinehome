import { createHash } from "crypto";
import { buildWorkerProxyUrl, isWorkerProxyEnabled } from "@/lib/worker-proxy";

export interface HlsSession {
  id: string;
  userId: string;
  referer: string;
  origin: string;
  userAgent: string;
  cookies: string;
  extraHeaders: Record<string, string>;
  rootUrl: string;
  /** Hostnames seen in rewritten manifests (segment CDNs). Grows as playlists are rewritten. */
  allowedHosts: Set<string>;
  expiresAt: number;
}

/** Session sliding TTL. Segment cache TTL is capped to remaining session life (see hls-proxy). */
export const SESSION_TTL_MS = 25 * 60 * 1000;

const sessions = new Map<string, HlsSession>();

type SessionEndListener = (sessionId: string) => void;
const sessionEndListeners: SessionEndListener[] = [];

/**
 * Register a callback when an HLS session is removed (expired purge or hard delete).
 * Used by hls-proxy to drop session-scoped cache entries only (global CDN bodies survive).
 */
export function onHlsSessionEnd(listener: SessionEndListener): void {
  sessionEndListeners.push(listener);
}

function emitSessionEnd(sessionId: string): void {
  for (const listener of sessionEndListeners) {
    try {
      listener(sessionId);
    } catch {
      /* never break session purge on cache cleanup failure */
    }
  }
}

function sessionKey(userId: string, rootUrl: string): string {
  return createHash("sha256").update(`${userId}:${rootUrl}`).digest("hex").slice(0, 32);
}

function rootHostname(rootUrl: string): string | null {
  try {
    return new URL(rootUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Record an absolute upstream URL's hostname on the session so subsequent
 * segment requests to rotating CDN hosts pass the SSRF allowlist.
 */
export function rememberUpstreamHost(session: HlsSession, url: string): void {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host) return;
    session.allowedHosts.add(host);
  } catch {
    /* ignore unparseable */
  }
}

/** Reuse an existing proxy session for the same user + upstream URL so refetches don't break playback. */
export function getOrCreateHlsSession(
  userId: string,
  rootUrl: string,
  ctx: {
    referer: string;
    origin: string;
    userAgent: string;
    cookies: string;
    extraHeaders?: Record<string, string>;
  }
): HlsSession {
  purgeExpired();
  const key = sessionKey(userId, rootUrl);
  const existing = sessions.get(key);
  if (existing && existing.userId === userId && Date.now() < existing.expiresAt) {
    existing.expiresAt = Date.now() + SESSION_TTL_MS;
    existing.referer = ctx.referer;
    existing.origin = ctx.origin;
    existing.userAgent = ctx.userAgent;
    existing.cookies = ctx.cookies;
    existing.extraHeaders = ctx.extraHeaders || {};
    // Keep allowedHosts; re-seed root if somehow empty.
    const root = rootHostname(rootUrl);
    if (root) existing.allowedHosts.add(root);
    return existing;
  }

  // Replacing a dead/other entry under the same key — drop any leftover cache for that id.
  if (existing) {
    sessions.delete(key);
    emitSessionEnd(key);
  }

  const allowedHosts = new Set<string>();
  const root = rootHostname(rootUrl);
  if (root) allowedHosts.add(root);

  const session: HlsSession = {
    id: key,
    userId,
    referer: ctx.referer,
    origin: ctx.origin,
    userAgent: ctx.userAgent,
    cookies: ctx.cookies,
    extraHeaders: ctx.extraHeaders || {},
    rootUrl,
    allowedHosts,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);
  return session;
}

export function createHlsSession(
  userId: string,
  rootUrl: string,
  ctx: {
    referer: string;
    origin: string;
    userAgent: string;
    cookies: string;
    extraHeaders?: Record<string, string>;
  }
): HlsSession {
  return getOrCreateHlsSession(userId, rootUrl, ctx);
}

export function getHlsSession(id: string): HlsSession | null {
  purgeExpired();
  const session = sessions.get(id);
  if (!session || Date.now() > session.expiresAt) {
    if (session) {
      sessions.delete(id);
      emitSessionEnd(id);
    }
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) {
      sessions.delete(id);
      emitSessionEnd(id);
    }
  }
}

export function encodeUpstream(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

export function decodeUpstream(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/**
 * Public proxy URL for an upstream media URI.
 * When WORKER_PROXY_BASE + WORKER_PROXY_SECRET are set, mints a signed
 * Cloudflare Worker URL (edge delivery). Otherwise falls back to home `/api/hls`.
 * Only mint Worker tokens for authenticated sessions (userId present via playback).
 */
export function proxyUrlFor(session: HlsSession, upstream: string): string {
  if (isWorkerProxyEnabled() && session.userId) {
    return buildWorkerProxyUrl(session, upstream);
  }
  return `/api/hls/${session.id}?u=${encodeUpstream(upstream)}`;
}
