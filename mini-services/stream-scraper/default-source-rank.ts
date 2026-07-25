/**
 * Default streamUrl ranking — aligned with client pickDefaultSource height tiers.
 * Pure helpers for sortSourcesForDefault (no network, no inventing heights).
 *
 * Tier order:
 *   0. Non-poison over poison (hard gate — abuse/hostinger/php wrappers last)
 *   1. Verified over soft-kept
 *   2. known height ≥ HD_FLOOR (1080)
 *   3. unknown height (≤ 0)
 *   4. known sub-HD
 */

import { isPoisonStreamUrl } from "./poison-url";

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
  probe?: { ok?: boolean; speedScore?: number } | null;
}

export type HeightInfer = (text: string) => number;

/**
 * Client-aligned height tier for ranking.
 * known ≥1080 → unknown (≤0) → known sub-HD.
 */
export function heightTierForRank(height: number): number {
  if (height >= HD_FLOOR_HEIGHT) return 2;
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
}

const noopInfer: HeightInfer = () => 0;

/**
 * Sort sources for default streamUrl pick.
 * Poison hard-gate first, then verified soft-kept, then HD/unknown/sub-HD tiers.
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

  return [...sources].sort((a, b) => {
    // Poison / junk never outrank a clean URL — even if probe.ok or verified.
    const aPoison = isPoisonStreamUrl(a.url) ? 1 : 0;
    const bPoison = isPoisonStreamUrl(b.url) ? 1 : 0;
    if (aPoison !== bPoison) return aPoison - bPoison;

    // Soft-kept dead URLs never outrank verified sources as default.
    const aVer = isRankableVerified(a) ? 1 : 0;
    const bVer = isRankableVerified(b) ? 1 : 0;
    if (aVer !== bVer) return bVer - aVer;

    const aH = effectiveMaxHeight(a, inferHeight);
    const bH = effectiveMaxHeight(b, inferHeight);
    const aTier = heightTierForRank(aH);
    const bTier = heightTierForRank(bH);
    if (aTier !== bTier) return bTier - aTier;

    // Among HD (tier 2): prefer meeting qualityHint when target is above floor (4K pref).
    if (qualityHint > HD_FLOOR_HEIGHT && aTier === 2) {
      const aMeet = aH >= qualityHint ? 1 : 0;
      const bMeet = bH >= qualityHint ? 1 : 0;
      if (aMeet !== bMeet) return bMeet - aMeet;
    }

    // Within tier 2 / tier 0: higher known height wins (4K > 1080; 720 > 480).
    // Tier 1 (unknown): heights are ≤0 — skip numeric thrash.
    if (aTier !== 1 && aH !== bH) return bH - aH;

    // Multi-rung ladder > single-rung at equal tier/height.
    const aLadder = (a.ladder?.length ?? 0) > 1 ? 1 : 0;
    const bLadder = (b.ladder?.length ?? 0) > 1 ? 1 : 0;
    if (aLadder !== bLadder) return bLadder - aLadder;

    if (anyProbe) {
      const aOk = a.probe?.ok ? 1 : 0;
      const bOk = b.probe?.ok ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;

      const aSp = a.probe?.ok ? (a.probe.speedScore ?? -1) : -1;
      const bSp = b.probe?.ok ? (b.probe.speedScore ?? -1) : -1;
      if (aSp !== bSp) return bSp - aSp;
    }

    // HLS preferred over MP4 at equal rank.
    const aHls = a.url.includes(".m3u8") ? 1 : 0;
    const bHls = b.url.includes(".m3u8") ? 1 : 0;
    if (aHls !== bHls) return bHls - aHls;

    const aHevc = isHevc(a.url) ? 1 : 0;
    const bHevc = isHevc(b.url) ? 1 : 0;
    if (aHevc !== bHevc) return aHevc - bHevc;

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
 * Poison only wins as last resort when every candidate is poison.
 */
export function pickDefaultStreamUrl<T extends RankableSource>(
  sources: T[],
  options: SortSourcesOptions = {}
): string | null {
  if (!sources.length) return null;
  const ranked = sortSourcesForDefault(sources, options);
  const clean = ranked.find((s) => !isPoisonStreamUrl(s.url));
  if (clean) return clean.url;
  // All poison — still return first so UI isn't empty (manual switch only).
  return ranked[0]?.url ?? null;
}
