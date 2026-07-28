import type { QualityLevel } from "@/stores/player-store";
import type { PlaybackSource } from "./types";
import {
  eligiblePlaybackSources,
  pickDefaultSource,
  sourceMaxHeight,
} from "./source-quality";
import { effectiveLevelHeight } from "./hls-quality";

/** Cineby-style stable rail. A rung stays visible even while it is unavailable. */
export const PLAYER_QUALITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360] as const;
export type PlayerQualityHeight = (typeof PLAYER_QUALITY_HEIGHTS)[number];
export type PlayerQualityTarget = "auto" | PlayerQualityHeight;
export type PlayerQualityStatus = "active" | "available" | "searching" | "unavailable";

export interface PlayerQualityOption {
  value: PlayerQualityTarget;
  label: string;
  status: PlayerQualityStatus;
  /** Same-manifest switch; preferred over a source replacement. */
  levelIndex?: number;
  /** Cross-source switch when the active manifest does not carry this rung. */
  sourceId?: string;
  /** Stored user target, even while playback is honestly using a fallback. */
  preferred?: boolean;
}

export function qualityLabel(height: PlayerQualityHeight): string {
  return height === 2160 ? "4K" : `${height}p`;
}

export function shouldCommitQualityTarget(
  option: PlayerQualityOption,
  allowUnavailablePreference = false
): boolean {
  if (option.value === "auto") return true;
  if (allowUnavailablePreference) return true;
  return option.status !== "unavailable" && option.status !== "searching";
}

/**
 * Map effective delivery heights onto the public rail without claiming an
 * arbitrary source is a quality it does not carry. Width-aware cropped
 * classification happens first in effectiveLevelHeight.
 */
export function normalizePlayerQualityHeight(
  height: number
): PlayerQualityHeight | null {
  if (height >= 1800) return 2160;
  if (height >= 1400 && height < 1800) return 1440;
  if (height >= 850 && height < 1400) return 1080;
  if (height >= 600 && height < 850) return 720;
  if (height >= 400 && height < 600) return 480;
  if (height >= 280 && height < 400) return 360;
  return null;
}

function sourceOffersHeight(
  source: PlaybackSource,
  height: PlayerQualityHeight
): boolean {
  const declared = source.ladder?.length
    ? source.ladder
    : [sourceMaxHeight(source)];
  return declared.some((candidate) => normalizePlayerQualityHeight(candidate) === height);
}

function levelForHeight(
  levels: QualityLevel[],
  height: PlayerQualityHeight
): number | undefined {
  const matching = levels
    .filter(
      (level) =>
        normalizePlayerQualityHeight(effectiveLevelHeight(level)) === height
    )
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return matching[0]?.index;
}

function viableSources(
  sources: PlaybackSource[],
  failedIds: ReadonlySet<string>
): PlaybackSource[] {
  return eligiblePlaybackSources(sources, failedIds);
}

export function selectSourceForQuality(
  sources: PlaybackSource[],
  height: PlayerQualityHeight,
  failedIds: ReadonlySet<string> = new Set()
): PlaybackSource | null {
  const candidates = viableSources(sources, failedIds).filter((source) =>
    sourceOffersHeight(source, height)
  );
  return pickDefaultSource(candidates, null, height);
}

export function buildPlayerQualityOptions(args: {
  sources: PlaybackSource[];
  activeSourceId?: string;
  activeLevels: QualityLevel[];
  selected: PlayerQualityTarget;
  failedIds?: ReadonlySet<string>;
  discovering?: boolean;
  /** Measured delivery height, separate from the user's preferred target. */
  actualHeight?: number;
}): PlayerQualityOption[] {
  const failedIds = args.failedIds ?? new Set<string>();
  const actualHeight = normalizePlayerQualityHeight(args.actualHeight ?? 0);
  const options: PlayerQualityOption[] = [
    {
      value: "auto",
      label: "Auto",
      status: args.selected === "auto" ? "active" : "available",
    },
  ];

  for (const height of PLAYER_QUALITY_HEIGHTS) {
    const levelIndex = levelForHeight(args.activeLevels, height);
    const source = selectSourceForQuality(args.sources, height, failedIds);
    const available = levelIndex != null || source != null;
    const preferred = args.selected === height;
    const isEffectiveFallback =
      args.selected !== "auto" && actualHeight === height;
    options.push({
      value: height,
      label: qualityLabel(height),
      status:
        (preferred && available && actualHeight == null) || isEffectiveFallback
          ? "active"
          : available
            ? "available"
            : args.discovering
              ? "searching"
              : "unavailable",
      ...(levelIndex != null ? { levelIndex } : {}),
      ...(source ? { sourceId: source.id } : {}),
      ...(preferred ? { preferred: true } : {}),
    });
  }
  return options;
}
