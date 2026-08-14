import type { PlaybackSource } from "./types";
import { formatBitrateMbps } from "./stream-info";
import { formatResolutionLabel, sourceMaxHeight } from "./source-quality";
import { sourceAudioLanguageCode } from "./source-facts";

export interface DownloadOption {
  id: string;
  sourceId: string;
  height: number;
  label: string;
  containerLabel: string;
  codecLabel: string;
  languageLabel: string;
  origin: "debrid" | "embed";
  serverLabel: string;
  sizeBytes?: number;
  estimatedSizeBytes?: number;
  bitrateBps?: number;
  downloadable: boolean;
  blockedReason?: string;
}

const PROGRESSIVE_URL =
  /\.(?:mp4|mkv|mov|webm|m4v)(?:$|[?#])/i;

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib >= 10 ? gib.toFixed(1) : gib.toFixed(2)} GB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function estimateSizeBytes(
  bitrateBps: number | undefined,
  durationSeconds: number | undefined
): number | undefined {
  if (!bitrateBps || bitrateBps <= 0) return undefined;
  if (!durationSeconds || durationSeconds <= 0) return undefined;
  return Math.round((bitrateBps * durationSeconds) / 8);
}

export function isProgressiveDownloadSource(source: PlaybackSource): boolean {
  if (source.origin === "debrid") return true;
  if (source.type === "mp4") return true;
  if (source.container === "mp4" || source.container === "mkv" || source.container === "mov") {
    return true;
  }
  return PROGRESSIVE_URL.test(source.url);
}

function containerLabel(source: PlaybackSource, url: string): string {
  if (source.container === "mkv") return "MKV";
  if (source.container === "webm") return "WebM";
  if (source.container === "mov") return "MOV";
  if (source.container === "mp4") return "MP4";
  if (/\.mkv(?:$|[?#])/i.test(url)) return "MKV";
  if (/\.webm(?:$|[?#])/i.test(url)) return "WebM";
  if (source.type === "mp4" || /\.mp4(?:$|[?#])/i.test(url)) return "MP4";
  return source.type === "hls" ? "HLS" : source.type.toUpperCase();
}

function codecLabel(source: PlaybackSource): string {
  if (source.codec === "hevc") return "HEVC";
  if (source.codec === "av1") return "AV1";
  if (source.codec === "h264") return "H.264";
  return "Video";
}

function languageLabel(source: PlaybackSource): string {
  const code = sourceAudioLanguageCode(source);
  if (code === "en") return "English";
  if (code === "und") return "Original";
  return code.toUpperCase();
}

function optionFromUrl(
  source: PlaybackSource,
  url: string,
  height: number,
  sizeBytes?: number,
  bitrateBps?: number
): DownloadOption {
  const downloadable =
    isProgressiveDownloadSource(source) &&
    !url.includes(".m3u8") &&
    !url.includes(".mpd");
  return {
    id: `${source.id}::${height}`,
    sourceId: source.id,
    height,
    label: formatResolutionLabel(height),
    containerLabel: containerLabel(source, url),
    codecLabel: codecLabel(source),
    languageLabel: languageLabel(source),
    origin: source.origin === "debrid" ? "debrid" : "embed",
    serverLabel: source.label || source.provider,
    ...(sizeBytes && sizeBytes > 0 ? { sizeBytes } : {}),
    ...(bitrateBps && bitrateBps > 0 ? { bitrateBps } : {}),
    downloadable,
    ...(!downloadable
      ? { blockedReason: "This source is a live stream, not a file" }
      : {}),
  };
}

/**
 * File downloads only. Adaptive HLS/DASH masters stay in the player.
 * One row per height, preferring a debrid file over an embed at the same tier.
 */
export function buildDownloadOptions(
  sources: readonly PlaybackSource[],
  durationSeconds = 0
): DownloadOption[] {
  const byHeight = new Map<number, DownloadOption>();

  const consider = (option: DownloadOption) => {
    const existing = byHeight.get(option.height);
    if (!existing) {
      byHeight.set(option.height, option);
      return;
    }
    const existingScore =
      (existing.origin === "debrid" ? 2 : 0) +
      (existing.downloadable ? 1 : 0) +
      (existing.sizeBytes ? 1 : 0);
    const nextScore =
      (option.origin === "debrid" ? 2 : 0) +
      (option.downloadable ? 1 : 0) +
      (option.sizeBytes ? 1 : 0);
    if (nextScore > existingScore) byHeight.set(option.height, option);
  };

  for (const source of sources) {
    if (source.qualityRungs?.length) {
      for (const rung of source.qualityRungs) {
        if (rung.height <= 0 || !rung.url) continue;
        const option = optionFromUrl(
          source,
          rung.url,
          rung.height,
          rung.sizeBytes ?? source.sizeBytes,
          rung.bitrateBps ?? source.bitrateBps
        );
        if (!option.sizeBytes) {
          const estimated = estimateSizeBytes(option.bitrateBps, durationSeconds);
          if (estimated) option.estimatedSizeBytes = estimated;
        }
        consider(option);
      }
      continue;
    }
    const height = sourceMaxHeight(source);
    if (height <= 0) continue;
    const option = optionFromUrl(
      source,
      source.url,
      height,
      source.sizeBytes,
      source.bitrateBps
    );
    if (!option.sizeBytes) {
      const estimated = estimateSizeBytes(option.bitrateBps, durationSeconds);
      if (estimated) option.estimatedSizeBytes = estimated;
    }
    consider(option);
  }

  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

export function downloadSizeLabel(option: DownloadOption): string {
  const exact = formatFileSize(option.sizeBytes);
  if (exact) return exact;
  const estimated = formatFileSize(option.estimatedSizeBytes);
  if (estimated) return `~${estimated}`;
  return "Size unknown";
}

export function downloadDetailLine(option: DownloadOption): string {
  const parts = [
    option.containerLabel,
    option.codecLabel,
    option.languageLabel,
    formatBitrateMbps(option.bitrateBps ?? 0),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function downloadFilename(
  title: string,
  option: DownloadOption
): string {
  const safe = title
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const ext = option.containerLabel.toLowerCase() === "mkv" ? "mkv" : "mp4";
  const base = safe || "cinehome";
  return `${base} ${option.label}.${ext}`;
}
