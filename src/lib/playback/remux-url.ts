import type { PlaybackSource } from "./types";
import {
  normalizeTrackLanguage,
  type AudioTrackSelection,
} from "./track-selection";

export function buildRemuxUrl(options: {
  source: PlaybackSource;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  audio: AudioTrackSelection;
  prewarm?: boolean;
  startAtSeconds?: number;
}): string {
  const params = new URLSearchParams({
    type: options.mediaType,
    id: String(options.tmdbId),
    sourceId: options.source.id,
    mode: "remux",
    audioPreference: options.audio.preference,
  });
  const originalLanguage = normalizeTrackLanguage(options.audio.originalLanguage);
  const preferredLanguage = normalizeTrackLanguage(options.audio.preferredLanguage);
  if (originalLanguage) params.set("originalLanguage", originalLanguage);
  if (preferredLanguage) params.set("audioLanguage", preferredLanguage);
  if (options.source.remuxTicket) {
    params.set("ticket", options.source.remuxTicket);
  }
  if (
    options.mediaType === "tv" &&
    options.season != null &&
    Number.isFinite(options.season) &&
    options.episode != null &&
    Number.isFinite(options.episode)
  ) {
    params.set("season", String(options.season));
    params.set("episode", String(options.episode));
  }
  if (options.prewarm) params.set("prewarm", "1");
  if (options.startAtSeconds && options.startAtSeconds > 0) {
    params.set("startAt", String(Math.floor(options.startAtSeconds)));
  }
  return `/api/transcode?${params.toString()}`;
}
