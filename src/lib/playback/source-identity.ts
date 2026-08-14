import type { PlaybackSource } from "./types";

const GENERIC_LABELS = new Set(["hls", "dash", "mp4", "direct", "stream", "auto", "link"]);
const SOURCE_ID_HASH_OFFSET = 0x811c9dc5;
const SOURCE_ID_HASH_PRIME = 0x01000193;
const SOURCE_ID_MAX_LENGTH = 64;
const SOURCE_ID_HASH_WIDTH = 7;
const PROXY_DATA_MAX_LENGTH = 32_768;

/**
 * One logical server row. Numbered multi-CDN captures (Solstice 2, Phoenix 3)
 * stay distinct so the Servers panel matches LordFlix-style switching.
 * Only exact same-name duplicates (e.g. two plain "Luna") collapse.
 */
export function sourceIdentity(provider: string, label: string): string {
  const p = provider.trim().toLowerCase();
  const l = label.trim().toLowerCase().replace(/\s+/g, " ");
  // Collapse only *exact* plain "Luna" from Vixsrc + CinePro/VixSrc — keep Luna 2, etc.
  if (
    l === "luna" ||
    (l === "" && p.includes("vixsrc") && !p.includes("videasy") && !p.includes("lordflix"))
  ) {
    return "luna";
  }
  // Numbered / quality-suffixed labels stay unique (Share 1080p, Phoenix 2, Vienna, …).
  if (l) {
    // Lordflix city names and CinePro friendly labels are the switch identity.
    if (
      l.startsWith("share") ||
      l.startsWith("horizon") ||
      l.startsWith("aether") ||
      l.startsWith("solstice") ||
      l.startsWith("phoenix") ||
      l.startsWith("pulse") ||
      l.startsWith("nest") ||
      l.startsWith("orion") ||
      l.startsWith("quasar") ||
      l.startsWith("nebula") ||
      // LordFlix-style city chips
      [
        "vienna",
        "lion",
        "sakura",
        "flower",
        "rio",
        "moscow",
        "berlin",
        "marseille",
        "oslo",
        "backrooms",
        "ativa",
      ].some((c) => l === c || l.startsWith(`${c} `))
    ) {
      return l.replace(/\s+/g, "-");
    }
  }
  if (l.startsWith("horizon") || (l === "" && p.includes("vidapi"))) {
    return l.startsWith("horizon") ? l.replace(/\s+/g, "-") : "horizon";
  }
  if (l.startsWith("aether") || (l === "" && p.includes("icefy"))) {
    return l.startsWith("aether") ? l.replace(/\s+/g, "-") : "aether";
  }
  if (l.startsWith("solstice") || (l === "" && p.includes("vidking"))) {
    return l.startsWith("solstice") ? l.replace(/\s+/g, "-") : "solstice";
  }
  if (l.startsWith("phoenix") || (l === "" && p.includes("vidlink") && !p.includes("lordflix"))) {
    return l.startsWith("phoenix") ? l.replace(/\s+/g, "-") : "phoenix";
  }
  if (l.startsWith("pulse") || (l === "" && p.includes("notorrent"))) {
    return l.startsWith("pulse") ? l.replace(/\s+/g, "-") : "pulse";
  }
  const server = l && !GENERIC_LABELS.has(l) ? l : "";
  return server ? `${p}|${server.replace(/\s+/g, "-")}` : p;
}

export function playbackSourceKey(source: PlaybackSource): string {
  return source.id;
}

/**
 * Auth/token query keys safe to drop when comparing stream identity.
 * Deliberately excludes short single/double-letter params (`t`, `h`, `ts`, …)
 * — CDNs reuse those for segment index / track id (wrong collapse risk).
 */
const EPHEMERAL_AUTH_PARAMS = new Set([
  "token",
  "expires",
  "expire",
  "exp",
  "sig",
  "signature",
  "auth",
  "authorization",
  "jwt",
  "access_token",
  "timestamp",
  "nonce",
]);

const VOLATILE_AUTH_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "apikey",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-date",
  "x-amz-security-token",
]);

type NormalizedHeader = [string, string | string[]];

/** Browser-safe base64url → utf8 (proxy `u=` param). */
function decodeBase64Url(encoded: string): string {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(encoded, "base64url").toString("utf8");
    }
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "===".slice((b64.length + 3) % 4);
    return atob(pad);
  } catch {
    return "";
  }
}

/**
 * Unwrap home `/api/hls/{session}?u=` proxy so dedup keys on real upstream,
 * not per-user session path segments.
 */
export function unwrapProxyUpstream(url: string): string {
  try {
    const u = new URL(url, "http://local");
    const path = u.pathname.replace(/\/+/g, "/");
    if (path.startsWith("/api/hls/") && u.searchParams.has("u")) {
      const raw = u.searchParams.get("u") || "";
      const decoded = decodeBase64Url(raw);
      if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
        return decoded;
      }
    }
  } catch {
    /* keep original */
  }
  return url;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function isVolatileAuthHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  const withoutExtensionPrefix = normalized.startsWith("x-")
    ? normalized.slice(2)
    : normalized;
  const paramStyle = withoutExtensionPrefix.replace(/-/g, "_");
  return (
    VOLATILE_AUTH_HEADERS.has(normalized) ||
    EPHEMERAL_AUTH_PARAMS.has(paramStyle)
  );
}

function normalizeProxyHeaders(value: unknown): NormalizedHeader[] | null {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) return null;
  const headers: NormalizedHeader[] = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (!name || isVolatileAuthHeader(name)) continue;
    if (typeof rawValue === "string") headers.push([name, rawValue]);
    else if (Array.isArray(rawValue) && rawValue.every((item) => typeof item === "string")) {
      headers.push([name, rawValue]);
    } else return null;
  }
  return headers.sort((left, right) => {
    const nameOrder = compareText(left[0], right[0]);
    return nameOrder || compareText(stableJson(left[1]), stableJson(right[1]));
  });
}

function buildUrlKey(url: URL, normalizeProxyDataValue: boolean): string {
  const path = url.pathname.replace(/\/+/g, "/");
  const isDataProxy = normalizeProxyDataValue && path.endsWith("/v1/proxy");
  const clean = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (EPHEMERAL_AUTH_PARAMS.has(key.toLowerCase())) continue;
    const normalizedValue =
      isDataProxy && key.toLowerCase() === "data"
        ? normalizeNestedProxyData(value)
        : value;
    clean.append(key, normalizedValue);
  }
  const query = clean.toString();
  return `${url.host || ""}${path}${query ? `?${query}` : ""}`;
}

function normalizeAbsoluteUpstreamKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return buildUrlKey(url, false);
  } catch {
    return null;
  }
}

function opaqueProxyData(rawData: string): string {
  return `opaque:${rawData.length}:${stableSourceHash(rawData)}`;
}

function normalizeNestedProxyData(rawData: string): string {
  const fallback = opaqueProxyData(rawData);
  if (!rawData || rawData.length > PROXY_DATA_MAX_LENGTH) return fallback;
  try {
    const payload: unknown = JSON.parse(rawData);
    if (!isRecord(payload) || typeof payload.url !== "string") return fallback;
    const url = normalizeAbsoluteUpstreamKey(payload.url);
    const headers = normalizeProxyHeaders(payload.headers);
    if (!url || headers === null) return fallback;
    const fields: [string, unknown][] = Object.entries(payload)
      .filter(([key]) => key !== "url" && key !== "headers");
    fields.push(["headers", headers], ["url", url]);
    fields.sort(([left], [right]) => compareText(left, right));
    return stableJson(fields);
  } catch {
    return fallback;
  }
}

/** Normalize URL for dedup — strip token/expiry so same stream collapses. */
export function normalizeUrlKey(url: string): string {
  try {
    const unwrapped = unwrapProxyUpstream(url);
    const u = new URL(unwrapped, "http://local");
    return buildUrlKey(u, true);
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function stableSourceHash(value: string): string {
  let hash = SOURCE_ID_HASH_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, SOURCE_ID_HASH_PRIME);
  }
  return (hash >>> 0).toString(36).padStart(SOURCE_ID_HASH_WIDTH, "0");
}

/**
 * Distinguish separate fixed/adaptive URLs that share a human server label.
 * Authentication parameters are normalized out, so token refreshes retain the
 * same id while genuine 1080p/2160p siblings remain independently selectable.
 */
export function sourceInstanceId(baseId: string, upstreamUrl: string): string {
  const suffix = stableSourceHash(normalizeUrlKey(upstreamUrl));
  const prefixMax = SOURCE_ID_MAX_LENGTH - suffix.length - 1;
  return `${baseId.slice(0, prefixMax)}-${suffix}`;
}

export function dedupePlaybackSources(sources: PlaybackSource[]): PlaybackSource[] {
  const byKey = new Map<string, PlaybackSource>();
  const byUrl = new Map<string, string>(); // urlKey → identity key
  for (const source of sources) {
    const key = playbackSourceKey(source);
    const urlKey = normalizeUrlKey(source.url);
    const existingByUrl = byUrl.get(urlKey);
    if (existingByUrl && existingByUrl !== key) {
      const other = byKey.get(existingByUrl);
      if (other && sourceScore(source) <= sourceScore(other)) continue;
      byKey.delete(existingByUrl);
    }
    const existing = byKey.get(key);
    if (!existing || sourceScore(source) > sourceScore(existing)) {
      byKey.set(key, source);
      byUrl.set(urlKey, key);
    }
  }
  return Array.from(byKey.values());
}

function sourceScore(source: PlaybackSource): number {
  let score = 0;
  if (source.type === "hls") score += 80;
  else if (source.type === "dash") score += 40;
  else score += 10;
  const url = source.url.toLowerCase();
  const p = source.provider.toLowerCase();
  const hevc =
    source.codec === "hevc" ||
    url.includes("h265") ||
    url.includes("hevc") ||
    url.includes("hev1");
  if (hevc) score -= 40;
  if (url.includes(".php") || url.includes("hostingersite")) score -= 50;
  // Prefer direct Vixsrc over CinePro double-hop Luna; Solstice over CinePro.
  if (p.includes("vidking")) score += 40;
  if (p === "vixsrc" || (p.includes("vixsrc") && !p.includes("cinepro"))) score += 25;
  if (p.includes("cinepro")) score += 5;
  if (source.probe?.ok) score += 30 + Math.min(source.probe.speedScore || 0, 50);
  if (source.probe && !source.probe.ok) score -= 100;
  if (source.maxHeight) score += Math.min(source.maxHeight / 20, 80);
  // Direct CDN (not cinepro-core proxy) preferred when scores close
  if (!url.includes("cinepro") && !url.includes("/v1/proxy")) score += 15;
  return score;
}
