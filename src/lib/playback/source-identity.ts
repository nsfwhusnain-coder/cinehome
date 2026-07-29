import type { PlaybackSource } from "./types";

const GENERIC_LABELS = new Set(["hls", "dash", "mp4", "direct", "stream", "auto", "link"]);

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
  // Real-Debrid deliberately resolves several distinct releases at the same
  // advertised height (native-1080-1/2/3). They share provider + label, but
  // their stable slot-bearing ids are separate failover servers. Collapsing
  // them by the generic display identity discards those proven backups before
  // they can reach the player or server picker.
  if (source.origin === "debrid") return `debrid:${source.id}`;
  return sourceIdentity(source.provider, source.label);
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
  "key",
  "hash",
  "auth",
  "authorization",
  "jwt",
  "access_token",
  "timestamp",
  "nonce",
]);

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
function unwrapProxyUpstream(url: string): string {
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

/** Normalize URL for dedup — strip token/expiry so same stream collapses. */
export function normalizeUrlKey(url: string): string {
  try {
    const unwrapped = unwrapProxyUpstream(url);
    const u = new URL(unwrapped, "http://local");
    const clean = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (EPHEMERAL_AUTH_PARAMS.has(k.toLowerCase())) continue;
      clean.set(k, v);
    }
    // Host + path so same CDN path across hosts still collapses when auth-only differs;
    // origin kept so distinct CDNs with identical paths stay separate.
    const path = u.pathname.replace(/\/+/g, "/");
    const q = clean.toString();
    const host = u.host || "";
    return `${host}${path}${q ? `?${q}` : ""}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
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
