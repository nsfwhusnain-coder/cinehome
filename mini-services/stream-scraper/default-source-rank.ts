/**
 * Default streamUrl ranking — aligned with client pickDefaultSource height tiers.
 * Pure helpers for sortSourcesForDefault (no network, no inventing heights).
 *
 * Tier order:
 *   0. Clean over never-auto-default (poison + trailer/sample/preview)
 *   1. Verified over soft-kept
 *   2. known height ≥ HD_FLOOR (1080)
 *   3. unknown height (≤ 0)
 *   4. known sub-HD
 */

import { isNeverAutoDefaultSource } from "./poison-url";

export const HD_FLOOR_HEIGHT = 1080;

/** Minimal shape needed for default ranking (SourceEntry-compatible). */
export interface RankableSource {
  url: string;
  label?: string;
  quality?: string;
  provider?: string;
  verified?: boolean;
  maxHeight?: number;
  ladder?: number[];
  /** Manifest-declared bitrate for the `maxHeight` rendition. */
  bitrateBps?: number;
  probe?: { ok?: boolean; speedScore?: number; bytesPerSec?: number } | null;
}

export type HeightInfer = (text: string) => number;

/**
 * Client-aligned height tier for ranking.
 * known ≥1080 → known ≥720 → unknown (≤0) → known sub-720.
 * Unknown used to outrank 720, which made unmeasured 480p MP4s beat Luna.
 */
export const WATCHABLE_HEIGHT = 720;

export function heightTierForRank(height: number): number {
  if (height >= HD_FLOOR_HEIGHT) return 3;
  if (height >= WATCHABLE_HEIGHT) return 2;
  if (height <= 0) return 1;
  return 0;
}

/** Soft-kept dead URLs use verified:false; everything else ranks as verified. */
export function isRankableVerified(entry: RankableSource): boolean {
  return entry.verified !== false;
}

/**
 * Effective max height without inventing values.
 * maxHeight > 0 → ladder[0] > 0 → token infer (may be 0 unknown).
 */
export function effectiveMaxHeight(
  entry: RankableSource,
  inferHeight: HeightInfer
): number {
  if (entry.maxHeight != null && entry.maxHeight > 0) return entry.maxHeight;
  if (entry.ladder?.[0] != null && entry.ladder[0] > 0) return entry.ladder[0];
  return inferHeight(`${entry.url} ${entry.label ?? ""} ${entry.quality ?? ""}`);
}

export const ANIME_CONTENT_CLASS = "anime";

export function isAnimeContentClass(value: string | undefined): boolean {
  return value === ANIME_CONTENT_CLASS;
}

/**
 * Anime HTTP hits are measured on Vidrock + NoTorrent. Boost only those two
 * so Luna/CinemaOS still win on a higher height tier / probe.ok.
 */
export function animeProviderBoost(
  provider: string,
  label: string,
  contentClass?: string
): number {
  if (!isAnimeContentClass(contentClass)) return 0;
  const p = provider.trim().toLowerCase();
  const l = label.trim().toLowerCase();
  if (p.includes("vidrock") || l === "rock" || l.startsWith("rock ")) return 2;
  if (p === "notorrent" || l.startsWith("pulse")) return 2;
  return 0;
}

export interface SortSourcesOptions {
  /** Preferred height from qualityHint (0 = use HD floor as soft target only). */
  qualityHintHeight?: number;
  /** Height inference from URL/label tokens; default returns 0 (unknown). */
  inferHeight?: HeightInfer;
  /** Optional secondary scorers (provider/codec) — kept injectable for index.ts. */
  isHevcStream?: (url: string) => boolean;
  codecOnlyScore?: (entry: RankableSource) => number;
  providerPriority?: (provider: string, label: string, url: string) => number;
  entryScore?: (entry: RankableSource) => number;
  /**
   * When `anime`, prefer Vidrock / NoTorrent at otherwise-equal rank.
   * Request-scoped ranking; include this in the result cache key.
   */
  contentClass?: string;
}

const noopInfer: HeightInfer = () => 0;
const BITRATE_STARTUP_HEADROOM_RATIO = 1.25;

/** Declared rates rank ahead of unknown rates, then richer known rates win. */
function compareDeclaredBitrate(a: RankableSource, b: RankableSource): number {
  const aRate = a.bitrateBps ?? 0;
  const bRate = b.bitrateBps ?? 0;
  const aKnown = aRate > 0 ? 1 : 0;
  const bKnown = bRate > 0 ? 1 : 0;
  if (aKnown !== bKnown) return bKnown - aKnown;
  if (!aKnown) return 0;
  return bRate - aRate;
}

function bitrateSustainabilityRank(source: RankableSource): -1 | 0 | 1 {
  const bitrate = source.bitrateBps ?? 0;
  const throughput = source.probe?.bytesPerSec ?? 0;
  if (bitrate <= 0 || source.probe?.ok !== true || throughput <= 0) return 0;
  if ((source.ladder?.length ?? 0) > 1) return 0;
  return throughput * 8 >= bitrate * BITRATE_STARTUP_HEADROOM_RATIO ? 1 : -1;
}

/**
 * Sort sources for default streamUrl pick.
 * Never-auto-default hard-gate first, then verified soft-kept, then HD/unknown/sub-HD tiers.
 */
export function sortSourcesForDefault<T extends RankableSource>(
  sources: T[],
  options: SortSourcesOptions = {}
): T[] {
  const inferHeight = options.inferHeight ?? noopInfer;
  const qualityHint =
    options.qualityHintHeight != null && options.qualityHintHeight > 0
      ? options.qualityHintHeight
      : HD_FLOOR_HEIGHT;
  const anyProbe = sources.some((s) => s.probe != null);
  const isHevc = options.isHevcStream ?? (() => false);
  const codecScore = options.codecOnlyScore ?? (() => 0);
  const prio =
    options.providerPriority ??
    ((_p: string, _l: string, _u: string) => 0);
  const eScore = options.entryScore ?? (() => 0);
  const contentClass = options.contentClass;

  return [...sources].sort((a, b) => {
    // Poison / trailer / sample never outrank a clean URL — even if probe.ok.
    const aBlocked = isNeverAutoDefaultSource(a.url, a.label) ? 1 : 0;
    const bBlocked = isNeverAutoDefaultSource(b.url, b.label) ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;

    // Soft-kept dead URLs never outrank verified sources as default.
    const aVer = isRankableVerified(a) ? 1 : 0;
    const bVer = isRankableVerified(b) ? 1 : 0;
    if (aVer !== bVer) return bVer - aVer;

    const aH = effectiveMaxHeight(a, inferHeight);
    const bH = effectiveMaxHeight(b, inferHeight);
    const aTier = heightTierForRank(aH);
    const bTier = heightTierForRank(bH);
    if (aTier !== bTier) return bTier - aTier;

    const aInsufficient = bitrateSustainabilityRank(a) < 0 ? 1 : 0;
    const bInsufficient = bitrateSustainabilityRank(b) < 0 ? 1 : 0;
    if (aInsufficient !== bInsufficient) return aInsufficient - bInsufficient;

    // Among HD (tier 2): prefer meeting qualityHint when target is above floor (4K pref).
    if (qualityHint > HD_FLOOR_HEIGHT && aTier === 2) {
      const aMeet = aH >= qualityHint ? 1 : 0;
      const bMeet = bH >= qualityHint ? 1 : 0;
      if (aMeet !== bMeet) return bMeet - aMeet;
    }

    if (anyProbe) {
      const probeRank = (source: RankableSource): number =>
        source.probe?.ok === true ? 1 : source.probe?.ok === false ? -1 : 0;
      const aOk = probeRank(a);
      const bOk = probeRank(b);
      if (aOk !== bOk) return bOk - aOk;
    }

    // Within tier 2 / tier 0: higher known height wins (4K > 1080; 720 > 480).
    // A requested 2160 target already won above; otherwise health evidence is
    // established first so an unproven 4K URL cannot displace working HD.
    if (aTier !== 1 && aH !== bH) return bH - aH;

    if (anyProbe) {

      const supportOrder =
        bitrateSustainabilityRank(b) - bitrateSustainabilityRank(a);
      if (supportOrder !== 0) return supportOrder;

      const bitrateOrder = compareDeclaredBitrate(a, b);
      if (bitrateOrder !== 0) return bitrateOrder;

      const aSp = a.probe?.ok ? (a.probe.speedScore ?? -1) : -1;
      const bSp = b.probe?.ok ? (b.probe.speedScore ?? -1) : -1;
      if (aSp !== bSp) return bSp - aSp;
    } else {
      const bitrateOrder = compareDeclaredBitrate(a, b);
      if (bitrateOrder !== 0) return bitrateOrder;
    }

    // Adaptive delivery is the tie-break only after measured encode richness.
    const aLadder = (a.ladder?.length ?? 0) > 1 ? 1 : 0;
    const bLadder = (b.ladder?.length ?? 0) > 1 ? 1 : 0;
    if (aLadder !== bLadder) return bLadder - aLadder;

    // HLS preferred over MP4 at equal rank.
    const aHls = a.url.includes(".m3u8") ? 1 : 0;
    const bHls = b.url.includes(".m3u8") ? 1 : 0;
    if (aHls !== bHls) return bHls - aHls;

    const aHevc = isHevc(a.url) ? 1 : 0;
    const bHevc = isHevc(b.url) ? 1 : 0;
    if (aHevc !== bHevc) return aHevc - bHevc;

    const aAnime = animeProviderBoost(a.provider ?? "", a.label ?? "", contentClass);
    const bAnime = animeProviderBoost(b.provider ?? "", b.label ?? "", contentClass);
    if (aAnime !== bAnime) return bAnime - aAnime;

    if (anyProbe) {
      return codecScore(b) - codecScore(a);
    }

    const prioDiff =
      prio(b.provider ?? "", b.label ?? "", b.url) -
      prio(a.provider ?? "", a.label ?? "", a.url);
    if (prioDiff !== 0) return prioDiff;
    return eScore(b) - eScore(a);
  });
}

/**
 * First URL after sortSourcesForDefault — rank order is the default pick.
 * Soft-kept only wins when no verified source exists (sort already enforces).
 * Poison / trailer / sample only win as last resort when every candidate is blocked.
 */
export function pickDefaultStreamUrl<T extends RankableSource>(
  sources: T[],
  options: SortSourcesOptions = {}
): string | null {
  if (!sources.length) return null;
  const ranked = sortSourcesForDefault(sources, options);
  const clean = ranked.find((s) => !isNeverAutoDefaultSource(s.url, s.label));
  if (clean) return clean.url;
  // All blocked — still return first so UI isn't empty (manual switch only).
  return ranked[0]?.url ?? null;
}
