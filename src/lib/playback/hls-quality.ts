import type { QualityLevel } from "@/stores/player-store";

export interface QualityOption {
  index: number;
  label: string;
  /** Effective rung height (2160 for 4K) — lets callers reason about the
   * option without re-deriving it from bitrate. */
  height: number;
  /**
   * True on the single highest rung when the whole ladder tops out below
   * the 1080p product floor (e.g. a 720p-only source) — UI badges this as
   * "max available" instead of implying more HD headroom exists above it.
   */
  isMaxAvailable?: boolean;
}

/**
 * Approximate resolution from bitrate (bps) when manifest omits height.
 * Conservative low-end thresholds so fixed 1080p prefs do not land on 480/720
 * when the ladder only exposes bitrate (common on proxy playlists).
 */
export function deriveHeightFromBitrate(bitrate: number): number {
  // Never invent 4K from bitrate. 8–20 Mbps is a normal 1080p encode
  // (Whiplash Luna looked like 4K and the rail said "playing 1080p").
  if (bitrate >= 5_500_000) return 1080;
  // Many 1080p ladders sit ~2.5–5 Mbps after re-encode — do not classify as 720.
  if (bitrate >= 2_500_000) return 1080;
  if (bitrate >= 1_200_000) return 720;
  if (bitrate >= 700_000) return 480;
  if (bitrate >= 400_000) return 360;
  return 0;
}

export function effectiveLevelHeight(
  level: Pick<QualityLevel, "height" | "width"> & { bitrate?: number }
): number {
  const width = level.width ?? 0;
  // Cinemascope encodes crop the raster height while retaining the delivery
  // class: 3840x1600 is 4K-class and 1920x800 is 1080p-class.
  if (width >= 3000 && level.height >= 1200) return 2160;
  if (width >= 1800 && level.height >= 700) return 1080;
  if (width >= 1200 && level.height >= 500) return 720;
  if (level.height > 0) return level.height;
  if (level.bitrate && level.bitrate > 0) return deriveHeightFromBitrate(level.bitrate);
  return 0;
}

/** Product floor — default start prefers 1080p and up when the source has it. */
export const MIN_QUALITY_OPTION_HEIGHT = 1080;

/**
 * Build the concrete (non-Auto) quality rungs for the picker.
 *
 * Shows **every distinct height** on the active source's ladder (4K → 360p),
 * so the user can switch freely. Default *playback* still starts at ≥1080
 * when available (`pickDefaultQualityIndex`); the menu is not filtered to
 * HD-only (that hid 720/480 and made single-rung 720 look like "only option").
 *
 * When the whole ladder tops out below 1080, the top rung is flagged
 * `isMaxAvailable` so the UI can badge it honestly.
 *
 * "Auto" is not in this list — the dock renders it as its own first row.
 */
export function levelsFromQualityRungs(
  rungs: ReadonlyArray<{ height: number; bitrateBps?: number }>
): QualityLevel[] {
  return rungs
    .filter((rung) => rung.height > 0)
    .map((rung, index) => ({
      index,
      height: rung.height,
      width: Math.round((rung.height * 16) / 9),
      bitrate: rung.bitrateBps ?? 0,
    }));
}

export function buildQualityOptions(levels: QualityLevel[]): QualityOption[] {
  const withHeights = levels
    .map((l) => ({ ...l, height: effectiveLevelHeight(l) }))
    .filter((l) => l.height > 0)
    .sort(
      (a, b) =>
        b.height - a.height || (b.bitrate ?? 0) - (a.bitrate ?? 0)
    );

  if (!withHeights.length) return [];

  const ladderMax = withHeights[0]!.height;
  const hasHd = ladderMax >= MIN_QUALITY_OPTION_HEIGHT;

  const seenHeights = new Set<number>();
  const options: QualityOption[] = [];
  for (const level of withHeights) {
    if (seenHeights.has(level.height)) continue;
    seenHeights.add(level.height);
    options.push({
      index: level.index,
      height: level.height,
      label: level.height >= 2160 ? "4K" : `${level.height}p`,
    });
  }

  if (!hasHd && options.length > 0) {
    options[0]!.isMaxAvailable = true;
  }

  return options;
}

/**
 * Annotate hls.js levels with heights when the master omits RESOLUTION.
 * Prefer: native dimensions → exact scrape ladder by rank → source max → bitrate guess.
 */
export function annotateLevelHeights(
  levels: ReadonlyArray<QualityLevel>,
  sourceLadder: ReadonlyArray<number> = [],
  sourceMaxHeight = 0
): QualityLevel[] {
  if (!levels.length) return [];

  const ladderDesc = [...sourceLadder]
    .filter((h) => h > 0)
    .sort((a, b) => b - a);

  // hls.js levels are usually bandwidth-ascending; map highest bitrate → highest ladder rung.
  const byBitrateAsc = levels
    .map((l, order) => ({ l, order, br: l.bitrate ?? 0 }))
    .sort((a, b) => a.br - b.br || a.order - b.order);

  const heightByIndex = new Map<number, number>();
  if (ladderDesc.length > 0 && levels.length > 1) {
    // Align lowest bitrate level with lowest ladder rung, highest with highest.
    const ladderAsc = [...ladderDesc].sort((a, b) => a - b);
    for (let i = 0; i < byBitrateAsc.length; i++) {
      const level = byBitrateAsc[i]!;
      const native = effectiveLevelHeight({
        height: level.l.height,
        width: level.l.width,
      });
      if (native > 0) {
        heightByIndex.set(level.l.index, native);
        continue;
      }
      // Proportionally map into ladder
      const rungIdx =
        byBitrateAsc.length === 1
          ? ladderAsc.length - 1
          : Math.round((i / (byBitrateAsc.length - 1)) * (ladderAsc.length - 1));
      heightByIndex.set(level.l.index, ladderAsc[Math.min(rungIdx, ladderAsc.length - 1)]!);
    }
  }

  return levels.map((l) => {
    let height = effectiveLevelHeight({ height: l.height, width: l.width });
    if (height <= 0 && heightByIndex.has(l.index)) {
      height = heightByIndex.get(l.index)!;
    }
    if (height <= 0 && levels.length === 1) {
      height =
        (ladderDesc[0] && ladderDesc[0] > 0 ? ladderDesc[0] : 0) ||
        (sourceMaxHeight > 0 ? sourceMaxHeight : 0);
    }
    if (height <= 0 && l.bitrate && l.bitrate > 0) {
      height = deriveHeightFromBitrate(l.bitrate);
    }
    return { ...l, height };
  });
}

export function findLevelForHeight(levels: QualityLevel[], targetHeight: number): number {
  if (!levels.length) return -1;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (const level of levels) {
    const height = effectiveLevelHeight(level);
    if (!height) continue;
    if (height <= targetHeight) {
      const diff = targetHeight - height;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = level.index;
      }
    }
  }
  if (bestIdx >= 0) return bestIdx;
  return levels.reduce((best, l) =>
    effectiveLevelHeight(l) > effectiveLevelHeight(best) ? l : best
  ).index;
}

export function maxLevelHeight(levels: QualityLevel[]): number {
  return levels.reduce((max, l) => Math.max(max, effectiveLevelHeight(l)), 0);
}

/**
 * Quality a background "promote" path is allowed to enforce.
 *
 * Auto owns only the product floor and must leave a sub-HD-only ladder to ABR.
 * A fixed user choice owns its exact requested height (bounded by the real
 * ladder ceiling). Without this distinction, FRAG_BUFFERED promoted a manual
 * 480p choice back to 720p, and a fixed 4K choice could be stranded at 1080p.
 */
export function hlsPromotionTargetHeight(
  levels: QualityLevel[],
  preferredHeight: number | "auto",
  productFloor = MIN_QUALITY_OPTION_HEIGHT
): number | null {
  const ladderMax = maxLevelHeight(levels);
  if (ladderMax <= 0) return null;
  if (preferredHeight !== "auto") {
    return Math.min(preferredHeight, ladderMax);
  }
  return ladderMax >= productFloor ? productFloor : null;
}

/**
 * ABR floor guard (shared hls.js/dash.js implementation — both map their
 * native level/quality lists into this same `QualityLevel` shape):
 * lowest level index whose height is still >= minHeight. If none meet the
 * floor (ladder maxes out below it), returns the highest available index
 * instead — never invents a floor that doesn't exist on this ladder.
 */
export function findMinLevelIndexForHeight(levels: QualityLevel[], minHeight: number): number {
  if (levels.length === 0) return -1;
  let bestIdx = -1;
  let bestH = Infinity;
  let bestBitrate = -1;
  for (const level of levels) {
    const h = effectiveLevelHeight(level);
    const bitrate = level.bitrate ?? 0;
    if (h >= minHeight && (h < bestH || (h === bestH && bitrate > bestBitrate))) {
      bestH = h;
      bestBitrate = bitrate;
      bestIdx = level.index;
    }
  }
  if (bestIdx >= 0) return bestIdx;
  // Ladder max is below minHeight — use best available.
  return levels.reduce((best, level) => {
    const height = effectiveLevelHeight(level);
    const bestHeight = effectiveLevelHeight(best);
    if (height !== bestHeight) return height > bestHeight ? level : best;
    return (level.bitrate ?? 0) > (best.bitrate ?? 0) ? level : best;
  }).index;
}

/**
 * Adaptive recovery target: highest lower rung at-or-below `targetHeight`.
 * If a sparse ladder has no rung that low, use its lowest rung below the
 * current height. Never returns the current/higher level or drops below min.
 */
export function findLowerLevelIndexForHeight(
  levels: QualityLevel[],
  currentHeight: number,
  targetHeight: number,
  minHeight = 0
): number {
  const lower = levels.filter((level) => {
    const height = effectiveLevelHeight(level);
    return height >= minHeight && height < currentHeight;
  });
  if (!lower.length) return -1;
  const atOrBelow = lower.filter(
    (level) => effectiveLevelHeight(level) <= targetHeight
  );
  const pool = atOrBelow.length ? atOrBelow : lower;
  return pool.reduce((best, level) =>
    atOrBelow.length
      ? effectiveLevelHeight(level) > effectiveLevelHeight(best) ? level : best
      : effectiveLevelHeight(level) < effectiveLevelHeight(best) ? level : best
  ).index;
}

export type AdaptiveRecoveryPhase = "hold" | "climb" | "floor";

/** Keep adaptive playback low until its forward buffer has genuinely recovered. */
export function adaptiveRecoveryPhase(
  policy: "adaptive" | "absolute",
  bufferAheadS: number,
  climbBackBufferS: number
): AdaptiveRecoveryPhase {
  if (policy === "absolute") return "floor";
  return bufferAheadS >= climbBackBufferS ? "climb" : "hold";
}

/**
 * Best level index for a target height. Prefers the lowest rung that is
 * still >= targetHeight (e.g. real 1080 over 1440/4K when target=1080) —
 * never picks below target when a >=target rung exists. Falls back to the
 * highest available rung when the whole ladder sits below target (honest
 * degrade, not an invented "good enough" pick).
 */
export function findBestLevelForTarget(levels: QualityLevel[], targetHeight: number): number {
  if (!levels.length) return -1;
  let best: QualityLevel | null = null;
  for (const level of levels) {
    const h = effectiveLevelHeight(level);
    if (h < targetHeight) continue;
    const bestHeight = best ? effectiveLevelHeight(best) : Infinity;
    if (
      h < bestHeight ||
      (h === bestHeight && (level.bitrate ?? 0) > (best?.bitrate ?? 0))
    ) {
      best = level;
    }
  }
  if (best) return best.index;
  return levels.reduce((current, level) => {
    const height = effectiveLevelHeight(level);
    const currentHeight = effectiveLevelHeight(current);
    if (height !== currentHeight) return height > currentHeight ? level : current;
    return (level.bitrate ?? 0) > (current.bitrate ?? 0) ? level : current;
  }).index;
}

/** Highest bitrate at the lowest rendition height meeting the requested floor. */
export function findFloorBitrateKbps(
  levels: QualityLevel[],
  minHeight: number
): number {
  const index = findBestLevelForTarget(levels, minHeight);
  const bitrate = levels.find((level) => level.index === index)?.bitrate ?? 0;
  return bitrate > 0 ? Math.round(bitrate / 1000) : 0;
}

/**
 * Default rung for a source with no explicit user pick applied yet: the
 * LOWEST rung meeting the 1080p floor (the owner's absolute base quality —
 * default selection is 1080p itself, never a jump straight to 1440/4K;
 * climbing above the floor is Auto/ABR's job, not the "default" pick's).
 *
 * When the whole ladder sits below 1080p there is no honest default to pick
 * silently — returns -1 so callers gate on the explicit "1080p isn't
 * available for this title" UI (see source-quality.ts's
 * `sourceRosterMeetsHdFloor` for the source-level equivalent) instead of
 * quietly landing on 720p/480p as if it were a normal default.
 *
 * Shared here so the picker's "Auto (up to Xp)" hint and the player's
 * initial level selection can never disagree.
 */
/** Highest raster, then richest bitrate — Ultra's 4K lock. */
export function pickHighestLevelIndex(levels: QualityLevel[]): number {
  if (!levels.length) return -1;
  return levels.reduce((best, level) => {
    const height = effectiveLevelHeight(level);
    const bestHeight = effectiveLevelHeight(best);
    if (height !== bestHeight) return height > bestHeight ? level : best;
    return (level.bitrate ?? 0) > (best.bitrate ?? 0) ? level : best;
  }).index;
}

export function pickDefaultQualityIndex(levels: QualityLevel[]): number {
  if (!levels.length) return -1;
  const withHeights = levels.map((l) => ({ ...l, height: effectiveLevelHeight(l) }));
  const atLeastFloor = withHeights.filter((l) => l.height >= MIN_QUALITY_OPTION_HEIGHT);
  if (!atLeastFloor.length) return -1;
  return atLeastFloor.reduce((best, level) => {
    if (level.height !== best.height) return level.height < best.height ? level : best;
    return (level.bitrate ?? 0) > (best.bitrate ?? 0) ? level : best;
  }).index;
}

/**
 * Which rung the FIRST fragment should come from.
 *
 * Distinct from `pickDefaultQualityIndex` in one way that matters: it never
 * answers -1 for a real ladder. hls.js treats -1 as "decide for yourself", and
 * left to itself it opens on whatever the master happens to list first — which
 * on most masters is the lowest rung. That is how the opening seconds decoded
 * at 480p and only climbed once ABR had measured the line (observed on Squid
 * Game S1E1: 854x480 at first frame, 1920x1080 twenty seconds later).
 *
 * So a ladder with no rung reaching the 1080p floor starts at its highest rung
 * instead of its lowest — an honest degrade rather than a guess downward.
 *
 * A fixed user preference is honoured directly; "auto" uses the same
 * lowest-rung-meeting-the-floor rule the rest of the player already applies,
 * so the first fragment and every fragment after it agree.
 */
export function pickStartLevelIndex(
  levels: QualityLevel[],
  target: "auto" | number
): number {
  if (!levels.length) return -1;
  if (typeof target === "number" && target >= 2160) {
    return pickHighestLevelIndex(levels);
  }
  if (target !== "auto") return findBestLevelForTarget(levels, target);
  const floorIdx = pickDefaultQualityIndex(levels);
  if (floorIdx >= 0) return floorIdx;
  // Whole ladder is sub-HD: open at the best it has, never the first listed.
  return levels.reduce((best, l) =>
    effectiveLevelHeight(l) > effectiveLevelHeight(best) ? l : best
  ).index;
}

/**
 * True when selected fixed height and actual decode height disagree enough
 * to show an honest mismatch hint in the dock (never for Auto / unknown).
 */
export function isQualityMismatch(
  selectedHeight: number,
  playingHeight: number,
  qualityIndex: number
): boolean {
  if (qualityIndex < 0) return false;
  if (selectedHeight <= 0 || playingHeight <= 0) return false;
  return playingHeight < selectedHeight * 0.9;
}
