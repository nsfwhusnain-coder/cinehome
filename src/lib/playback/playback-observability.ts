/**
 * Structured Playback Observability & Correlation Tracking.
 *
 * Tracks the complete journey from Play request to stream delivery with microsecond
 * resolution, stage deltas, and structured JSON logs without log spam.
 */

export interface PlaybackStageMark {
  stage: string;
  timestamp: number;
  elapsedMs: number;
  deltaMs: number;
  metadata?: Record<string, unknown>;
}

export interface PlaybackSessionSummary {
  playbackId: string;
  mediaType: string;
  tmdbId: number;
  season?: number;
  episode?: number;
  totalDurationMs: number;
  selectedSource?: {
    id: string;
    provider: string;
    quality: string;
    isDebrid: boolean;
    isRemux: boolean;
  };
  stages: PlaybackStageMark[];
}

export class PlaybackTracker {
  public readonly playbackId: string;
  public readonly mediaType: string;
  public readonly tmdbId: number;
  public readonly season?: number;
  public readonly episode?: number;
  private readonly startTime: number;
  private lastMarkTime: number;
  private readonly marks: PlaybackStageMark[] = [];
  private selectedSourceInfo?: PlaybackSessionSummary["selectedSource"];

  constructor(args: {
    playbackId?: string;
    mediaType: string;
    tmdbId: number;
    season?: number;
    episode?: number;
  }) {
    this.playbackId =
      args.playbackId ||
      "pb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    this.mediaType = args.mediaType;
    this.tmdbId = args.tmdbId;
    this.season = args.season;
    this.episode = args.episode;
    this.startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.lastMarkTime = this.startTime;

    this.mark("play_request_received");
  }

  public mark(stage: string, metadata?: Record<string, unknown>): this {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsedMs = Math.round((now - this.startTime) * 100) / 100;
    const deltaMs = Math.round((now - this.lastMarkTime) * 100) / 100;
    this.lastMarkTime = now;

    this.marks.push({
      stage,
      timestamp: Date.now(),
      elapsedMs,
      deltaMs,
      ...(metadata ? { metadata } : {}),
    });

    return this;
  }

  public setSelectedSource(source: {
    id: string;
    provider?: string;
    quality?: string;
    isDebrid?: boolean;
    isRemux?: boolean;
  }): this {
    this.selectedSourceInfo = {
      id: source.id,
      provider: source.provider || "unknown",
      quality: source.quality || "auto",
      isDebrid: Boolean(source.isDebrid),
      isRemux: Boolean(source.isRemux),
    };
    return this.mark("selected_source", {
      id: source.id,
      provider: source.provider,
      quality: source.quality,
    });
  }

  public getSummary(): PlaybackSessionSummary {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const totalDurationMs = Math.round((now - this.startTime) * 100) / 100;

    return {
      playbackId: this.playbackId,
      mediaType: this.mediaType,
      tmdbId: this.tmdbId,
      season: this.season,
      episode: this.episode,
      totalDurationMs,
      selectedSource: this.selectedSourceInfo,
      stages: this.marks,
    };
  }

  public logSummary(level: "info" | "debug" = "info"): void {
    const summary = this.getSummary();
    const payload = JSON.stringify({
      event: "playback_pipeline_summary",
      ...summary,
    });
    if (level === "info") {
      console.info(payload);
    } else {
      console.debug(payload);
    }
  }

  public getTimingHeaderValue(): string {
    return this.playbackId + ";dur=" + Math.round(this.getSummary().totalDurationMs);
  }
}
