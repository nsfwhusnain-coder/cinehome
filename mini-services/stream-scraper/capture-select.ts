/**
 * Multi-URL capture selection for Playwright embeds.
 * Pure helpers — prefer HLS masters / highest inferred height, never flood the roster.
 */

import { inferHeightFromUrl } from "./quality-probe";

/** Ephemeral auth query keys stripped for dedup identity (path identity kept). */
const EPHEMERAL_QUERY_KEYS = new Set([
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

/** Max alternate quality rungs surfaced when only single-rendition media playlists exist. */
const MAX_MEDIA_QUALITY_VARIANTS = 2;
/** Minimum height gap (px) before a second media playlist is kept as a separate source. */
const MIN_MEANINGFUL_HEIGHT_GAP = 200;

export interface SelectableCapture {
  url: string;
  quality: string;
  label: string;
  referer: string;
  origin: string;
  userAgent: string;
  score: number;
  /** Confirmed multi-rendition master (manifest peek). */
  isMaster?: boolean;
}

/**
 * Normalize a stream URL for dedup: drop ephemeral auth tokens, keep host+path
 * and non-auth query params that can identify distinct variants.
 */
export function normalizeStreamUrl(url: string): string {
  try {
    const u = new URL(url);
    const clean = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (EPHEMERAL_QUERY_KEYS.has(k.toLowerCase())) continue;
      clean.set(k, v);
    }
    const q = clean.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
  } catch {
    return url;
  }
}

/** Cheap path/name heuristics — not a substitute for isHlsMasterManifest. */
export function looksLikeHlsMasterUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower.includes(".m3u8")) return false;
  // Explicit variant media playlists (Vidking child rungs) are never masters.
  if (looksLikeVariantChildUrl(url)) return false;
  if (/master|manifest|playlist\.m3u8|index\.m3u8|multi|adaptive/.test(lower)) {
    // Media rungs often share "index.m3u8" under a height folder — demote those.
    if (inferHeightFromUrl(url) > 0 && /\/(2160|1440|1080|720|480|360)p?\//i.test(lower)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * True for discrete quality child playlists (not the adaptive master).
 * Promoting these as separate "servers" floods the roster and breaks ranking.
 */
export function looksLikeVariantChildUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower.includes(".m3u8")) return false;
  // Vidking / similar: index-s2160p.m3u8, index-s1080p-hevc.m3u8
  if (/index-s\d{3,4}p/i.test(lower)) return true;
  if (/\/s(2160|1440|1080|720|480|360)p[\/._-]/i.test(lower)) return true;
  // Height folder media: .../1080/index.m3u8 (single-rung) — kept as media when no master
  // but excluded from "master" class; not filtered here so pure /1080/ sources still work.
  return false;
}

function isHls(url: string): boolean {
  return url.toLowerCase().includes(".m3u8");
}

function isDash(url: string): boolean {
  return url.toLowerCase().includes(".mpd");
}

function isMp4ish(url: string, label: string): boolean {
  const lower = url.toLowerCase();
  if (isHls(url) || isDash(url)) return false;
  return lower.includes(".mp4") || lower.includes(".m4s") || label === "MP4" || label === "Direct";
}

function preferCapture(a: SelectableCapture, b: SelectableCapture): SelectableCapture {
  if ((a.isMaster ? 1 : 0) !== (b.isMaster ? 1 : 0)) {
    return a.isMaster ? a : b;
  }
  const ha = inferHeightFromUrl(a.url);
  const hb = inferHeightFromUrl(b.url);
  if (ha !== hb) return ha > hb ? a : b;
  return a.score >= b.score ? a : b;
}

/**
 * Deduplicate captures by normalized URL, keeping the better of each identity.
 */
export function dedupeCapturesByNormalizedUrl<T extends SelectableCapture>(captures: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const cap of captures) {
    const key = normalizeStreamUrl(cap.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cap);
      continue;
    }
    byKey.set(key, preferCapture(existing, cap) as T);
  }
  return Array.from(byKey.values());
}

/**
 * Select up to `maxCount` captures from a multi-URL embed interception set.
 *
 * Preference order:
 * 1. Confirmed / heuristic HLS masters (player needs the ladder)
 * 2. Highest URL-token media playlists (top 1–2 when meaningfully different)
 * 3. DASH then progressive MP4 fill
 */
export function selectEmbedCaptures<T extends SelectableCapture>(
  captures: T[],
  maxCount: number
): T[] {
  if (maxCount <= 0 || captures.length === 0) return [];

  const unique = dedupeCapturesByNormalizedUrl(captures);
  const picked: T[] = [];
  const seen = new Set<string>();

  const push = (cap: T): boolean => {
    const key = normalizeStreamUrl(cap.url);
    if (seen.has(key) || picked.length >= maxCount) return false;
    seen.add(key);
    picked.push(cap);
    return true;
  };

  const hls = unique.filter((c) => isHls(c.url));
  const masters = hls.filter((c) => c.isMaster || looksLikeHlsMasterUrl(c.url));
  // Prefer non-child media; only use index-s1080p-style URLs when no master exists.
  const mediaPlain = hls.filter((c) => !masters.includes(c) && !looksLikeVariantChildUrl(c.url));
  const mediaChildren = hls.filter((c) => !masters.includes(c) && looksLikeVariantChildUrl(c.url));

  // Masters first (score desc among masters).
  for (const cap of [...masters].sort((a, b) => b.score - a.score)) {
    push(cap);
    if (picked.length >= maxCount) return picked;
  }

  const keptMaster = picked.some(
    (c) => isHls(c.url) && (c.isMaster || looksLikeHlsMasterUrl(c.url))
  );

  // When a real master was kept, skip sibling media playlists (ladder is in-master).
  if (!keptMaster && picked.length < maxCount) {
    const mediaOnly = mediaPlain.length ? mediaPlain : mediaChildren;
    if (mediaOnly.length) {
      let mediaVariantsSelected = 0;
      const byHeight = [...mediaOnly].sort((a, b) => {
        const ha = inferHeightFromUrl(a.url);
        const hb = inferHeightFromUrl(b.url);
        if (ha !== hb) return hb - ha;
        return b.score - a.score;
      });
      const best = byHeight[0]!;
      if (push(best)) mediaVariantsSelected = 1;
      // Only multi-height fill for plain media (not child-rung spam).
      if (mediaPlain.length && picked.length < maxCount && byHeight.length > 1) {
        const bestH = inferHeightFromUrl(best.url);
        for (let i = 1; i < byHeight.length && mediaVariantsSelected < MAX_MEDIA_QUALITY_VARIANTS; i++) {
          const cand = byHeight[i]!;
          const h = inferHeightFromUrl(cand.url);
          if (bestH > 0 && h > 0 && bestH - h < MIN_MEANINGFUL_HEIGHT_GAP) continue;
          if (bestH > 0 && h === 0) continue;
          if (push(cand)) mediaVariantsSelected += 1;
          if (picked.length >= maxCount) return picked;
        }
      }
    }
  }

  // Alternate masters only (never re-add variant child media).
  if (masters.length > 0 && picked.length < maxCount) {
    const restMasters = masters
      .filter((c) => !seen.has(normalizeStreamUrl(c.url)))
      .sort((a, b) => b.score - a.score);
    for (const cap of restMasters) {
      push(cap);
      if (picked.length >= maxCount) return picked;
    }
  }

  const dash = unique
    .filter((c) => isDash(c.url) && !seen.has(normalizeStreamUrl(c.url)))
    .sort((a, b) => {
      const ha = inferHeightFromUrl(a.url);
      const hb = inferHeightFromUrl(b.url);
      if (ha !== hb) return hb - ha;
      return b.score - a.score;
    });
  for (const cap of dash) {
    push(cap);
    if (picked.length >= maxCount) return picked;
  }

  const mp4 = unique
    .filter((c) => isMp4ish(c.url, c.label) && !seen.has(normalizeStreamUrl(c.url)))
    .sort((a, b) => {
      const ha = inferHeightFromUrl(a.url);
      const hb = inferHeightFromUrl(b.url);
      if (ha !== hb) return hb - ha;
      return b.score - a.score;
    });
  for (const cap of mp4) {
    push(cap);
    if (picked.length >= maxCount) return picked;
  }

  // Residual non-HLS only (extension-less Direct, etc.). Never re-add media rungs.
  const residual = unique
    .filter((c) => !isHls(c.url) && !seen.has(normalizeStreamUrl(c.url)))
    .sort((a, b) => b.score - a.score);
  for (const cap of residual) {
    push(cap);
    if (picked.length >= maxCount) return picked;
  }

  return picked;
}

/**
 * Quality-primary rank key for a source entry after scrape.
 * Higher is better. Callers still apply verified-first soft-keep floor separately.
 */
export function qualityRankScore(input: {
  maxHeight?: number;
  ladder?: number[];
  url: string;
  label?: string;
  quality?: string;
  probeOk?: boolean;
  verified?: boolean;
  latencyMs?: number;
}): number {
  const height =
    (input.maxHeight != null && input.maxHeight > 0
      ? input.maxHeight
      : input.ladder?.[0] && input.ladder[0] > 0
        ? input.ladder[0]
        : inferHeightFromUrl(`${input.url} ${input.label ?? ""} ${input.quality ?? ""}`)) || 0;

  // Verified floor must dominate any height (incl. 2160*1000) so soft-kept
  // never outrank verified when both are candidates for default pick scoring.
  const VERIFIED_FLOOR = 10_000_000;
  const PROBE_OK_BONUS = 100_000;
  let score = height * 1000;
  if (input.verified !== false) score += VERIFIED_FLOOR;
  if (input.probeOk) score += PROBE_OK_BONUS;

  const lower = input.url.toLowerCase();
  const isHlsUrl = lower.includes(".m3u8");
  const isMp4Url = lower.includes(".mp4") && !isHlsUrl;
  if (isHlsUrl) score += 50;
  else if (isMp4Url) score += 10;

  if (input.ladder && input.ladder.length > 1) score += 25;

  // Lower latency better — map into a small band when known.
  if (input.latencyMs != null && Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    score += Math.max(0, 40 - Math.min(40, Math.floor(input.latencyMs / 50)));
  }

  return score;
}
