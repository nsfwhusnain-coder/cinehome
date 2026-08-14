export interface VidlinkQualityRung {
  height: number;
  url: string;
}

export interface VidlinkStream {
  url: string;
  quality: string;
  label: string;
  score: number;
  type?: "hls" | "mp4" | "dash";
  maxHeight?: number;
  ladder?: number[];
  qualityRungs?: VidlinkQualityRung[];
}

interface QualitySlot {
  url?: unknown;
  type?: unknown;
}

export function scoreVidlinkUrl(url: string): number {
  if (url.includes(".m3u8")) return 100;
  if (url.includes(".mpd")) {
    if (url.includes("h265") || url.includes("hevc")) return 80;
    return 95;
  }
  if (url.includes("/h265/") || url.includes("h265")) return 15;
  if (url.includes(".mp4") && !url.includes(".srt")) return 92;
  return 30;
}

export function vidlinkStreamTypeFromUrl(url: string): "hls" | "mp4" | "dash" {
  const lower = url.toLowerCase();
  if (lower.includes(".mpd")) return "dash";
  if (lower.includes(".m3u8")) return "hls";
  return "mp4";
}

function heightFromQualityKey(key: string): number {
  const n = parseInt(key, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function extractVidlinkQualityMap(
  node: unknown
): Record<string, QualitySlot> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractVidlinkQualityMap(item);
      if (found) return found;
    }
    return null;
  }
  const rec = node as Record<string, unknown>;
  if (rec.qualities && typeof rec.qualities === "object" && !Array.isArray(rec.qualities)) {
    return rec.qualities as Record<string, QualitySlot>;
  }
  for (const value of Object.values(rec)) {
    const found = extractVidlinkQualityMap(value);
    if (found) return found;
  }
  return null;
}

export function qualityMapToStream(
  qualities: Record<string, QualitySlot>
): VidlinkStream | null {
  const rungs: VidlinkQualityRung[] = [];
  const seen = new Set<string>();
  for (const [key, slot] of Object.entries(qualities)) {
    const height = heightFromQualityKey(key);
    const url = typeof slot?.url === "string" ? slot.url.trim() : "";
    if (!url.startsWith("http") || url.includes(".srt") || seen.has(url) || height <= 0) {
      continue;
    }
    seen.add(url);
    rungs.push({ height, url });
  }
  rungs.sort((a, b) => b.height - a.height);
  const best = rungs[0];
  if (!best) return null;
  return {
    url: best.url,
    quality: `${best.height}p`,
    label: "MP4",
    score: scoreVidlinkUrl(best.url) + 20,
    type: vidlinkStreamTypeFromUrl(best.url),
    maxHeight: best.height,
    ladder: rungs.map((rung) => rung.height),
    qualityRungs: rungs,
  };
}

export function extractVidlinkStreams(data: unknown): VidlinkStream[] {
  const found: VidlinkStream[] = [];
  const mapped = extractVidlinkQualityMap(data);
  const ladder = mapped ? qualityMapToStream(mapped) : null;
  const ladderUrls = new Set((ladder?.qualityRungs ?? []).map((rung) => rung.url));
  if (ladder) found.push(ladder);

  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === "string") {
      if (
        node.startsWith("http") &&
        !node.includes(".srt") &&
        !ladderUrls.has(node) &&
        (node.includes(".m3u8") || node.includes(".mp4") || node.includes(".mpd"))
      ) {
        const type = vidlinkStreamTypeFromUrl(node);
        const label = type === "hls" ? "HLS" : type === "dash" ? "DASH" : "MP4";
        found.push({
          url: node,
          quality: "auto",
          label,
          score: scoreVidlinkUrl(node),
          type,
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(data);
  const seen = new Set<string>();
  return found
    .filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}
