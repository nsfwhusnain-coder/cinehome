/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { PlaybackTracker } from "./playback-observability";

describe("PlaybackTracker Observability", () => {
  it("creates a tracker with generated playback ID and initial mark", () => {
    const tracker = new PlaybackTracker({
      mediaType: "movie",
      tmdbId: 550,
    });
    expect(tracker.playbackId).toStartWith("pb_");
    expect(tracker.mediaType).toBe("movie");
    expect(tracker.tmdbId).toBe(550);

    const summary = tracker.getSummary();
    expect(summary.stages.length).toBe(1);
    expect(summary.stages[0].stage).toBe("play_request_received");
    expect(summary.stages[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks sequential marks with elapsed and delta times", () => {
    const tracker = new PlaybackTracker({
      playbackId: "pb_test_123",
      mediaType: "tv",
      tmdbId: 1399,
      season: 1,
      episode: 1,
    });

    expect(tracker.playbackId).toBe("pb_test_123");
    tracker.mark("source_memory_lookup", { cached: true });
    tracker.mark("debrid_resolution", { count: 3 });
    tracker.setSelectedSource({
      id: "rd:torrentio:4k",
      provider: "realdebrid",
      quality: "2160p",
      isDebrid: true,
      isRemux: true,
    });

    const summary = tracker.getSummary();
    expect(summary.stages.length).toBe(4);
    expect(summary.selectedSource?.id).toBe("rd:torrentio:4k");
    expect(summary.selectedSource?.provider).toBe("realdebrid");
    expect(summary.selectedSource?.quality).toBe("2160p");
    expect(summary.selectedSource?.isRemux).toBe(true);

    const header = tracker.getTimingHeaderValue();
    expect(header).toStartWith("pb_test_123;dur=");
  });
});
