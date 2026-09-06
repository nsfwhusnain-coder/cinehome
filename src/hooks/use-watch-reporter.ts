"use client";

import { useEffect, useRef } from "react";
import {
  clearFeedbackTitleContext,
  emitPlayerFeedback,
  setFeedbackTitleContext,
} from "@/lib/playback/player-feedback";
import {
  createWatchClock,
  flushWatch,
  startWatching,
  stopWatching,
  type WatchClock,
} from "@/lib/playback/watch-clock";

/**
 * Reports how long each source was actually watched, feeding per-title source
 * memory (`src/lib/playback/source-memory.ts`).
 *
 * Deliberately a separate effect with its own listeners rather than additions
 * to the player's main media-event block. Those handlers drive the attempt
 * controller and the stall watchdogs, where an ordering mistake fails a healthy
 * source; these are **purely observational** — they only move a counter and can
 * neither fail a source nor change playback. That isolation is the point.
 *
 * (This is not the duplicate-listener trap from `player-keyboard-ownership`:
 * that bug came from two handlers running the same *side effects* on the same
 * keys. Two independent readers of the same media event are harmless.)
 */
export interface WatchReporterParams {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sourceId: string | null | undefined;
  provider: string | null | undefined;
  label: string | null | undefined;
  tmdbId: number | undefined;
  mediaType: "movie" | "tv" | undefined;
  season: number | undefined;
  episode: number | undefined;
}

export function useWatchReporter({
  videoRef,
  sourceId,
  provider,
  label,
  tmdbId,
  mediaType,
  season,
  episode,
}: WatchReporterParams): void {
  const clockRef = useRef<WatchClock>(createWatchClock());
  // Kept in a ref so the flush closure always reports the source that earned
  // the time, not whichever one happens to be active when teardown runs.
  // Mirrored in an effect, never during render: a render-phase assignment is
  // the `react-hooks/refs` defect already logged against the player, and the
  // teardown that reads this runs strictly after commit, so an effect is both
  // correct and sufficient.
  const attributionRef = useRef({ sourceId, provider, label });
  useEffect(() => {
    attributionRef.current = { sourceId, provider, label };
  }, [sourceId, provider, label]);

  useEffect(() => {
    setFeedbackTitleContext({
      tmdbId: tmdbId != null ? String(tmdbId) : undefined,
      mediaType: mediaType ?? "movie",
      season,
      episode,
    });
    return () => clearFeedbackTitleContext();
  }, [tmdbId, mediaType, season, episode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceId) return;

    const flush = () => {
      const { flushed, next } = flushWatch(clockRef.current, Date.now());
      clockRef.current = next;
      const attribution = attributionRef.current;
      if (!flushed || !attribution.provider) return;
      emitPlayerFeedback({
        event: "sustained_play",
        sourceId: flushed.sourceId,
        provider: attribution.provider,
        watchedMs: flushed.watchedMs,
        decodedHeight: video.videoHeight > 0 ? video.videoHeight : undefined,
      });
    };

    const onPlaying = () => {
      clockRef.current = startWatching(clockRef.current, sourceId, Date.now());
    };
    // Buffering, seeking and pausing all stop the clock: an abandoned tab or a
    // stalled 4K segment must never accumulate as viewing time, or a broken
    // source would look watched and get promoted.
    const onHalt = () => {
      clockRef.current = stopWatching(clockRef.current, Date.now());
    };
    const onEnded = () => {
      onHalt();
      flush();
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onHalt);
    video.addEventListener("waiting", onHalt);
    video.addEventListener("seeking", onHalt);
    video.addEventListener("ended", onEnded);
    // `pagehide` rather than `unload`: it is the only one that fires reliably
    // on iOS and on bfcache navigations, which is exactly when a viewer closes
    // a finished film. sendBeacon inside emit survives the teardown.
    window.addEventListener("pagehide", flush);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onHalt);
      video.removeEventListener("waiting", onHalt);
      video.removeEventListener("seeking", onHalt);
      video.removeEventListener("ended", onEnded);
      window.removeEventListener("pagehide", flush);
      // Source switch or player teardown — bank whatever this source earned.
      flush();
    };
  }, [videoRef, sourceId]);
}
