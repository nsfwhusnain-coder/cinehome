import { normalizeStreamUrl } from "./capture-select";

export function mergeDistinctStreamEntries<T extends { url: string }>(
  ranked: readonly T[],
  prefer: (existing: T | undefined, candidate: T) => T
): T[] {
  const byUrl = new Map<string, T>();
  for (const entry of ranked) {
    const key = normalizeStreamUrl(entry.url);
    byUrl.set(key, prefer(byUrl.get(key), entry));
  }
  return Array.from(byUrl.values());
}
