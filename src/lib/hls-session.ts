import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
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

const DASH_TEMPLATE_PARAM = "dash";
const DASH_TEMPLATE_VALUE_PREFIX = "dv";
const DASH_BASE_MAP_PARAM = "dbm";
const DASH_BASE_MAP_SIGNATURE_PARAM = "dbs";
const DASH_BASE_MAP_REPRESENTATION_PARAM = "dbr";
const MAX_DASH_TEMPLATE_VALUES = 16;
const MAX_DASH_NUMERIC_VALUE_LENGTH = 32;
const MAX_DASH_REPRESENTATION_ID_LENGTH = 256;
const MAX_DASH_BASE_MAP_ENTRIES = 64;
const MAX_DASH_BASE_MAP_BYTES = 16 * 1024;
const MAX_DASH_BASE_URL_LENGTH = 4 * 1024;
const DASH_REPRESENTATION_ID_PREFIX = "chrep.";
const DASH_REPRESENTATION_SIGNATURE_LENGTH = 22;
const DASH_TEMPLATE_SERVER_SECRET = randomBytes(32);
const DASH_TEMPLATE_TOKEN_RE =
  /\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)([diouxX]))?\$/g;
const DASH_ANY_TEMPLATE_TOKEN_RE = /\$\$|\$[^$]+\$/g;
const DASH_REPRESENTATION_ID_FORBIDDEN_RE = /[\u0000-\u0020\u007f/\\?#&%+]/;
const DASH_REPRESENTATION_ID_XML_INVALID_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

interface DashTemplateToken {
  kind: "RepresentationID" | "Bandwidth" | "Number" | "Time" | "Dollar";
  minimumWidth: number;
  specifier: string;
}

export interface DashTemplateRepresentationBase {
  representationId: string;
  baseUrl: string;
}

function dashTemplateToken(raw: string): DashTemplateToken | null {
  if (raw === "$$") {
    return { kind: "Dollar", minimumWidth: 0, specifier: "" };
  }
  const match = raw.match(
    /^\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)([diouxX]))?\$$/
  );
  if (!match) return null;
  return {
    kind: match[1] as DashTemplateToken["kind"],
    minimumWidth: Number(match[2] || 0),
    specifier: match[3] || "d",
  };
}

function isValidDashNumericValue(value: string, token: DashTemplateToken): boolean {
  if (value.length === 0 || value.length > MAX_DASH_NUMERIC_VALUE_LENGTH) return false;
  if (token.minimumWidth > 0 && value.length < token.minimumWidth) return false;
  if (token.specifier === "o") return /^[0-7]+$/.test(value);
  if (token.specifier === "x" || token.specifier === "X") {
    return /^[0-9A-Fa-f]+$/.test(value);
  }
  return /^\d+$/.test(value);
}

function dashRepresentationSignature(session: HlsSession, payload: string): string | null {
  return createHmac("sha256", DASH_TEMPLATE_SERVER_SECRET)
    .update(`${session.id}\u0000${payload}`)
    .digest("base64url")
    .slice(0, DASH_REPRESENTATION_SIGNATURE_LENGTH);
}

function dashBaseMapSignature(
  session: HlsSession,
  upstreamTemplate: string,
  payload: string
): string {
  return createHmac("sha256", DASH_TEMPLATE_SERVER_SECRET)
    .update(`base-map\u0000${session.id}\u0000${upstreamTemplate}\u0000${payload}`)
    .digest("base64url")
    .slice(0, DASH_REPRESENTATION_SIGNATURE_LENGTH);
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function isSafeRawDashRepresentationId(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_DASH_REPRESENTATION_ID_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith(DASH_REPRESENTATION_ID_PREFIX) &&
    !DASH_REPRESENTATION_ID_FORBIDDEN_RE.test(value)
  );
}

/** Encode unsafe XML Representation IDs so dash.js can carry them through a query value. */
export function dashRepresentationIdForProxy(
  session: HlsSession,
  representationId: string
): string | null {
  if (isSafeRawDashRepresentationId(representationId)) return representationId;
  if (
    representationId.length === 0 ||
    Buffer.byteLength(representationId, "utf8") > MAX_DASH_REPRESENTATION_ID_LENGTH ||
    DASH_REPRESENTATION_ID_XML_INVALID_RE.test(representationId)
  ) {
    return null;
  }
  const payload = Buffer.from(representationId, "utf8").toString("base64url");
  const signature = dashRepresentationSignature(session, payload);
  return signature ? `${DASH_REPRESENTATION_ID_PREFIX}${payload}.${signature}` : null;
}

function decodeDashRepresentationId(session: HlsSession, value: string): string | null {
  if (isSafeRawDashRepresentationId(value)) return value;
  if (!value.startsWith(DASH_REPRESENTATION_ID_PREFIX)) return null;
  const signed = value.slice(DASH_REPRESENTATION_ID_PREFIX.length);
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = signed.slice(0, separator);
  const signature = signed.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const expected = dashRepresentationSignature(session, payload);
  if (!expected || !signaturesMatch(signature, expected)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) return null;
  if (Buffer.byteLength(decoded, "utf8") > MAX_DASH_REPRESENTATION_ID_LENGTH) return null;
  return DASH_REPRESENTATION_ID_XML_INVALID_RE.test(decoded) ? null : decoded;
}

function dashTemplateValue(
  session: HlsSession,
  value: string,
  token: DashTemplateToken
): string | null {
  if (token.kind === "Dollar") return value === "$" ? value : null;
  if (token.kind === "RepresentationID") return decodeDashRepresentationId(session, value);
  return isValidDashNumericValue(value, token) ? value : null;
}

function dashTemplateTokens(upstreamTemplate: string): string[] | null {
  const tokens = [...upstreamTemplate.matchAll(DASH_ANY_TEMPLATE_TOKEN_RE)].map(
    (match) => match[0]
  );
  if (tokens.length > MAX_DASH_TEMPLATE_VALUES) return null;
  for (const raw of tokens) {
    const token = dashTemplateToken(raw);
    if (!token || token.minimumWidth > MAX_DASH_NUMERIC_VALUE_LENGTH) return null;
  }
  return tokens;
}

function validDashBaseUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DASH_BASE_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function encodeDashBaseMap(
  entries: readonly DashTemplateRepresentationBase[],
  relativeTemplate: string
): string | null {
  if (
    entries.length === 0 ||
    entries.length > MAX_DASH_BASE_MAP_ENTRIES ||
    relativeTemplate.length === 0 ||
    Buffer.byteLength(relativeTemplate, "utf8") > MAX_DASH_BASE_URL_LENGTH
  ) {
    return null;
  }
  const unique = new Map<string, string>();
  for (const entry of entries) {
    if (
      entry.representationId.length === 0 ||
      Buffer.byteLength(entry.representationId, "utf8") > MAX_DASH_REPRESENTATION_ID_LENGTH ||
      DASH_REPRESENTATION_ID_XML_INVALID_RE.test(entry.representationId) ||
      !validDashBaseUrl(entry.baseUrl)
    ) {
      return null;
    }
    const existing = unique.get(entry.representationId);
    if (existing && existing !== entry.baseUrl) return null;
    unique.set(entry.representationId, entry.baseUrl);
  }
  const json = JSON.stringify({ bases: [...unique], relativeTemplate });
  if (Buffer.byteLength(json, "utf8") > MAX_DASH_BASE_MAP_BYTES) return null;
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeDashBaseMap(
  payload: string
): { bases: Map<string, string>; relativeTemplate: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const decoded = Buffer.from(payload, "base64url");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_DASH_BASE_MAP_BYTES ||
    decoded.toString("base64url") !== payload
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { bases?: unknown; relativeTemplate?: unknown };
    if (
      !Array.isArray(value.bases) ||
      value.bases.length > MAX_DASH_BASE_MAP_ENTRIES ||
      typeof value.relativeTemplate !== "string" ||
      value.relativeTemplate.length === 0 ||
      Buffer.byteLength(value.relativeTemplate, "utf8") > MAX_DASH_BASE_URL_LENGTH
    ) {
      return null;
    }
    const result = new Map<string, string>();
    for (const entry of value.bases) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        entry[0].length === 0 ||
        Buffer.byteLength(entry[0], "utf8") > MAX_DASH_REPRESENTATION_ID_LENGTH ||
        DASH_REPRESENTATION_ID_XML_INVALID_RE.test(entry[0]) ||
        !validDashBaseUrl(entry[1]) ||
        result.has(entry[0])
      ) {
        return null;
      }
      result.set(entry[0], entry[1]);
    }
    return result.size > 0
      ? { bases: result, relativeTemplate: value.relativeTemplate }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep DASH placeholders visible to dash.js while the upstream template remains
 * opaque and bound to the authenticated home-proxy session.
 */
export function buildDashTemplateProxyUrl(
  session: HlsSession,
  upstreamTemplate: string,
  representationBases: readonly DashTemplateRepresentationBase[] = [],
  relativeTemplate = ""
): string | null {
  const tokens = dashTemplateTokens(upstreamTemplate);
  if (!tokens || (tokens.length === 0 && representationBases.length === 0)) return null;

  let proxyUrl =
    `/api/hls/${encodeURIComponent(session.id)}?u=${encodeUpstream(upstreamTemplate)}` +
    `&${DASH_TEMPLATE_PARAM}=1`;
  for (let index = 0; index < tokens.length; index++) {
    proxyUrl += `&${DASH_TEMPLATE_VALUE_PREFIX}${index}=${tokens[index]}`;
  }
  if (representationBases.length > 0) {
    const payload = encodeDashBaseMap(representationBases, relativeTemplate);
    if (!payload) return null;
    const signature = dashBaseMapSignature(session, upstreamTemplate, payload);
    proxyUrl +=
      `&${DASH_BASE_MAP_REPRESENTATION_PARAM}=$RepresentationID$` +
      `&${DASH_BASE_MAP_PARAM}=${payload}` +
      `&${DASH_BASE_MAP_SIGNATURE_PARAM}=${signature}`;
  }
  return proxyUrl;
}

function resolveDashMappedBase(
  session: HlsSession,
  upstreamTemplate: string,
  searchParams: URLSearchParams
): { present: boolean; baseUrl: string | null; relativeTemplate: string | null } {
  const payload = searchParams.get(DASH_BASE_MAP_PARAM);
  const signature = searchParams.get(DASH_BASE_MAP_SIGNATURE_PARAM);
  const transportedId = searchParams.get(DASH_BASE_MAP_REPRESENTATION_PARAM);
  const present = payload !== null || signature !== null || transportedId !== null;
  if (!present) return { present: false, baseUrl: null, relativeTemplate: null };
  if (!payload || !signature || !transportedId) {
    return { present: true, baseUrl: null, relativeTemplate: null };
  }
  const expected = dashBaseMapSignature(session, upstreamTemplate, payload);
  if (!signaturesMatch(signature, expected)) {
    return { present: true, baseUrl: null, relativeTemplate: null };
  }
  const representationId = decodeDashRepresentationId(session, transportedId);
  const baseMap = decodeDashBaseMap(payload);
  return {
    present: true,
    baseUrl:
      representationId && baseMap ? baseMap.bases.get(representationId) ?? null : null,
    relativeTemplate: baseMap?.relativeTemplate ?? null,
  };
}

/** Rebuild an upstream DASH URL using only validated dash.js token substitutions. */
export function resolveDashTemplateUpstream(
  session: HlsSession,
  upstreamTemplate: string,
  searchParams: URLSearchParams
): string | null {
  if (searchParams.get(DASH_TEMPLATE_PARAM) !== "1") return null;
  const tokens = dashTemplateTokens(upstreamTemplate);
  if (!tokens) return null;
  let index = 0;
  let valid = true;
  const resolved = upstreamTemplate.replace(DASH_TEMPLATE_TOKEN_RE, (raw: string) => {
    if (index >= MAX_DASH_TEMPLATE_VALUES) {
      valid = false;
      return raw;
    }
    const value = searchParams.get(`${DASH_TEMPLATE_VALUE_PREFIX}${index}`);
    const token = dashTemplateToken(raw);
    index += 1;
    const replacement = value !== null && token ? dashTemplateValue(session, value, token) : null;
    if (replacement === null) {
      valid = false;
      return raw;
    }
    return replacement;
  });
  if (!valid || index !== tokens.length) return null;
  const mappedBase = resolveDashMappedBase(session, upstreamTemplate, searchParams);
  if (!mappedBase.present) return resolved;
  if (!mappedBase.baseUrl || !mappedBase.relativeTemplate) return null;
  try {
    let relativeIndex = 0;
    let relativeValid = true;
    const substitutedRelative = mappedBase.relativeTemplate.replace(
      DASH_TEMPLATE_TOKEN_RE,
      (raw: string) => {
        const value = searchParams.get(`${DASH_TEMPLATE_VALUE_PREFIX}${relativeIndex}`);
        const token = dashTemplateToken(raw);
        relativeIndex += 1;
        const replacement =
          value !== null && token ? dashTemplateValue(session, value, token) : null;
        if (replacement === null) relativeValid = false;
        return replacement ?? raw;
      }
    );
    if (!relativeValid || relativeIndex !== tokens.length) return null;
    const absolute = new URL(substitutedRelative, mappedBase.baseUrl);
    return absolute.protocol === "http:" || absolute.protocol === "https:"
      ? absolute.toString()
      : null;
  } catch {
    return null;
  }
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
  return homeProxyUrlFor(session, upstream);
}

/** Authenticated same-origin proxy URL, independent of optional Worker settings. */
export function homeProxyUrlFor(session: HlsSession, upstream: string): string {
  return `/api/hls/${session.id}?u=${encodeUpstream(upstream)}`;
}
