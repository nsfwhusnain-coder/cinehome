import type { QualityLevel } from "@/stores/player-store";
import type { PlaybackSource } from "./types";
import {
  isSourcePlayableHere,
  pickDefaultSource,
  sourceMaxHeight,
  sourceUnavailableReason,
} from "./source-quality";
import { effectiveLevelHeight } from "./hls-quality";

/** Cineby-style stable rail. A rung stays visible even while it is unavailable. */
export const PLAYER_QUALITY_HEIGHTS = [2160, 1080, 720, 480, 360] as const;
export type PlayerQualityHeight = (typeof PLAYER_QUALITY_HEIGHTS)[number];
export type PlayerQualityTarget = "auto" | PlayerQualityHeight;
export type PlayerQualityStatus =
  | "active"
  | "available"
  | "searching"
  | "device-unsupported"
  | "unavailable";

export interface PlayerQualityOption {
  value: PlayerQualityTarget;
  label: string;
  status: PlayerQualityStatus;
  /** Same-manifest switch; preferred over a source replacement. */
  levelIndex?: number;
  /** Cross-source switch when the active manifest does not carry this rung. */
  sourceId?: string;
  /** Why discovered inventory cannot be selected on this browser/device. */
  unavailableReason?: string;
}

export function qualityLabel(height: PlayerQualityHeight): string {
  return height === 2160 ? "4K" : `${height}p`;
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
  if (height >= 850 && height < 1800) return 1080;
  if (height >= 600 && height < 850) return 720;
  if (height >= 400 && height < 600) return 480;
  if (height >= 280 && height < 400) return 360;
  return null;
}

export function sourceOffersHeight(
  source: PlaybackSource,
  height: PlayerQualityHeight
): boolean {
  const declared = source.qualityRungs?.length
    ? source.qualityRungs.map((rung) => rung.height)
    : source.ladder?.length
      ? source.ladder
      : [sourceMaxHeight(source)];
  return declared.some((candidate) => normalizePlayerQualityHeight(candidate) === height);
}

export function pickQualityRungUrl(
  source: PlaybackSource,
  target: PlayerQualityTarget
): string | null {
  const rungs = source.qualityRungs;
  if (!rungs?.length) return null;
  if (target === "auto") {
    const hd = rungs.find((rung) => rung.height >= 1080);
    return (hd ?? rungs[0])!.url;
  }
  const match = rungs.find(
    (rung) => normalizePlayerQualityHeight(rung.height) === target
  );
  return (match ?? rungs.find((rung) => rung.height >= 1080) ?? rungs[0])!.url;
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
  return sources.filter(
    (source) =>
      !failedIds.has(source.id) &&
      source.probe?.ok !== false &&
      source.verified !== false &&
      isSourcePlayableHere(source)
  );
}

/** Same eligibility as `viableSources`, without the device codec gate. This
 * preserves one consistent inventory across browsers while selection remains
 * strict: unsupported media is visible and explained, never auto-played. */
function discoveredSources(
  sources: PlaybackSource[],
  failedIds: ReadonlySet<string>
): PlaybackSource[] {
  return sources.filter(
    (source) =>
      !failedIds.has(source.id) &&
      source.probe?.ok !== false &&
      source.verified !== false
  );
}

function discoveredSourceForQuality(
  sources: PlaybackSource[],
  height: PlayerQualityHeight,
  failedIds: ReadonlySet<string>
): PlaybackSource | null {
  const candidates = discoveredSources(sources, failedIds).filter((source) =>
    sourceOffersHeight(source, height)
  );
  // `pickDefaultSource` intentionally removes decode-incompatible sources;
  // this inventory-only path must not. Stable id ordering keeps the explanatory
  // reason deterministic when several unsupported releases share a rung.
  return [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

/** True when this source (or the decoded frame) already is the requested rung. */
export function alreadyAtQualityTarget(
  target: PlayerQualityTarget,
  args: {
    playingHeight?: number;
    source?: PlaybackSource | null;
  }
): boolean {
  if (target === "auto") return false;
  if (normalizePlayerQualityHeight(args.playingHeight ?? 0) === target) {
    return true;
  }
  return args.source ? sourceOffersHeight(args.source, target) : false;
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
}): PlayerQualityOption[] {
  const failedIds = args.failedIds ?? new Set<string>();
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
    const discoveredSource = available
      ? null
      : discoveredSourceForQuality(args.sources, height, failedIds);
    const unavailableReason = discoveredSource
      ? sourceUnavailableReason(discoveredSource)
      : null;
    options.push({
      value: height,
      label: qualityLabel(height),
      status:
        args.selected === height && available
          ? "active"
          : available
            ? "available"
            : unavailableReason
              ? "device-unsupported"
              : args.discovering
                ? "searching"
                : "unavailable",
      ...(levelIndex != null ? { levelIndex } : {}),
      ...(source ? { sourceId: source.id } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }
  return options;
}
