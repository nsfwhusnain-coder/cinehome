import type { MediaTrack, QualityLevel } from "@/stores/player-store";
import { decodedQualityHeight, formatResolutionLabel } from "./source-quality";
import type { PlaybackSource } from "./types";

export interface StreamInfoRow {
  label: string;
  value: string;
}

export interface StreamInfoInput {
  source: PlaybackSource | null;
  serverName: string;
  playingWidth: number;
  playingHeight: number;
  playingBitrate: number;
  playingFps: number;
  levels: QualityLevel[];
  audioTracks: MediaTrack[];
  activeAudioId: number;
  bufferAheadS: number;
}

export function formatBitrateMbps(bps: number): string | null {
  if (!Number.isFinite(bps) || bps <= 0) return null;
  const mbps = bps / 1_000_000;
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

export function formatFrameRate(fps: number): string | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded} fps` : `${rounded.toFixed(2)} fps`;
}

export function formatResolution(width: number, height: number): string | null {
  if (height <= 0 && width <= 0) return null;
  const tier = decodedQualityHeight(width, height) || height;
  if (width > 0 && height > 0) {
    return `${width} × ${height} · ${formatResolutionLabel(tier)}`;
  }
  return formatResolutionLabel(tier);
}

export function inferDynamicRange(
  source: PlaybackSource | null,
  levels: QualityLevel[]
): string {
  const hay = [
    source?.codec ?? "",
    source?.label ?? "",
    source?.quality ?? "",
    ...levels.map((level) => level.videoCodec ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  if (/dolby.?vision|\bdvhe\b|\bdvh1\b/.test(hay)) return "Dolby Vision";
  if (/\bhdr10\+/.test(hay)) return "HDR10+";
  if (/\bhdr10\b|\bhdr\b|\bhev1\.2|\bhvc1\.2/.test(hay)) return "HDR";
  return "SDR";
}

export function formatVideoCodec(
  source: PlaybackSource | null,
  levels: QualityLevel[]
): string | null {
  const fromLevel = levels.find((level) => level.videoCodec)?.videoCodec;
  if (fromLevel) return prettyCodec(fromLevel);
  if (source?.codec === "hevc") return "HEVC";
  if (source?.codec === "av1") return "AV1";
  if (source?.codec === "h264") return "H.264";
  return null;
}

export function formatDelivery(source: PlaybackSource | null): string {
  if (!source) return "Unknown";
  if (source.type === "dash") return "DASH";
  if (source.type === "mp4") return source.container === "mkv" ? "MKV remux" : "MP4";
  return source.ladder && source.ladder.length > 1 ? "HLS adaptive" : "HLS";
}

function prettyCodec(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("hvc1") || lower.includes("hev1") || lower.includes("hevc")) return "HEVC";
  if (lower.includes("av01") || lower.includes("av1")) return "AV1";
  if (lower.includes("avc1") || lower.includes("avc") || lower.includes("h264")) return "H.264";
  return raw.toUpperCase();
}

function audioLine(tracks: MediaTrack[], activeId: number): string | null {
  if (!tracks.length) return null;
  const active = tracks.find((track) => track.id === activeId) ?? tracks[0];
  if (!active) return null;
  const parts = [
    active.name || active.lang?.toUpperCase() || null,
    active.channels ?? null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function bufferLine(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

/** TV-style stats. Rows are omitted when we have no honest value. */
export function buildStreamInfoRows(input: StreamInfoInput): StreamInfoRow[] {
  const liveBitrate = formatBitrateMbps(input.playingBitrate);
  const output = formatResolution(input.playingWidth, input.playingHeight);
  const listedHeight = input.source?.maxHeight ?? 0;
  const outputTier =
    decodedQualityHeight(input.playingWidth, input.playingHeight) ||
    input.playingHeight;
  const listedDisagrees =
    Boolean(output) &&
    listedHeight >= 1080 &&
    Math.abs(listedHeight - outputTier) >= 400;
  const rows: Array<[string, string | null]> = [
    ["Output", output],
    ["Listed as", listedDisagrees ? formatResolutionLabel(listedHeight) : null],
    ["Bitrate", liveBitrate],
    ["Video", formatVideoCodec(input.source, input.levels)],
    ["Frame rate", formatFrameRate(input.playingFps)],
    ["Audio", audioLine(input.audioTracks, input.activeAudioId)],
    ["Dynamic range", inferDynamicRange(input.source, input.levels)],
    ["Delivery", formatDelivery(input.source)],
    ["Source", input.serverName || input.source?.label || null],
    [
      "Link speed",
      input.source?.probe?.ok
        ? `${Math.max(0.1, input.source.probe.bytesPerSec / 1_000_000).toFixed(1)} MB/s`
        : null,
    ],
    ["Buffer", bufferLine(input.bufferAheadS)],
  ];
  return rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([label, value]) => ({ label, value }));
}
