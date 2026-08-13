import { isPoisonStreamUrl } from "./poison-url";

export interface QualityDiscoveryEntry {
  url: string;
  provider: string;
  type?: "hls" | "mp4" | "dash";
  maxHeight?: number;
  ladder?: number[];
  qualitySource?: "manifest" | "label" | "probe" | "unknown";
  verified?: boolean;
  probe?: { ok?: boolean };
}

function isQualityDiscoveryCandidate(
  entry: QualityDiscoveryEntry,
  preferredHeight: number
): boolean {
  const knownHeight = Math.max(entry.maxHeight ?? 0, entry.ladder?.[0] ?? 0);
  if (
    entry.verified === false ||
    entry.probe?.ok === false ||
    isPoisonStreamUrl(entry.url)
  ) {
    return false;
  }
  const needsMeasuredCorrection =
    preferredHeight > knownHeight &&
    entry.qualitySource !== "manifest" &&
    entry.qualitySource !== "probe";
  if (knownHeight > 0 && !needsMeasuredCorrection) return false;
  const lower = entry.url.toLowerCase();
  return (
    entry.type === "hls" ||
    entry.type === "dash" ||
    entry.type === "mp4" ||
    lower.includes(".m3u8") ||
    lower.includes(".mpd") ||
    lower.includes(".mp4")
  );
}

export function capRosterWithQualityReserve<T extends QualityDiscoveryEntry>(
  ranked: T[],
  cap: number,
  reserve: number,
  preferredHeight = 0
): T[] {
  if (ranked.length <= cap) return ranked;
  const overflow = ranked
    .slice(cap)
    .filter((entry) => isQualityDiscoveryCandidate(entry, preferredHeight));
  const selected: T[] = [];
  const providers = new Set<string>();
  for (const entry of overflow) {
    const provider = entry.provider.trim().toLowerCase();
    if (providers.has(provider)) continue;
    providers.add(provider);
    selected.push(entry);
    if (selected.length >= reserve) break;
  }
  const keepPrimary = Math.max(0, cap - selected.length);
  return [...ranked.slice(0, keepPrimary), ...selected];
}
