import type { MediaType } from "../types";
import type { CachedStreamKey } from "./cached-stream";

/** `debrid-tt0137523-movie-0-0-native-2160` / `torbox-tt…-2160p` */
export function parseDebridPlaybackSourceId(
  sourceId: string
): CachedStreamKey | null {
  const match = sourceId.match(
    /^(debrid|torbox)-(tt\d+)-(movie|tv)-(\d+)-(\d+)-(.+)$/
  );
  if (!match) return null;
  return {
    provider: match[1] === "torbox" ? "torbox" : "realdebrid",
    imdbId: match[2]!,
    mediaType: match[3] as MediaType,
    season: Number(match[4]),
    episode: Number(match[5]),
    quality: match[6] as CachedStreamKey["quality"],
  };
}
