export type MediaType = "movie" | "tv";

export interface PlaybackRequest {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  userId: string;
  fast?: boolean;
  noCache?: boolean;
  /**
   * Preferred playback height from Settings (1080 / 2160 / "auto").
   * Passed to scraper as qualityHint so ranking prefers matching rungs
   * before the player ever starts (Change 3 / 11).
   */
  qualityHint?: "auto" | number;
}

export type PlaybackStatus =
  | "available" // streamUrl is ready
  | "requestable" // not in library, but can be requested via *arr etc.
  | "external" // available on a paid service (Netflix etc.) — show link
  | "not_configured" // no provider set up yet
  | "error";

/** Measured home-server latency probe (from stream-scraper full path). */
export interface SourceProbeMetrics {
  ok: boolean;
  ttfbMs: number;
  bytesPerSec: number;
  speedScore: number;
}

export interface PlaybackSource {
  id: string;
  url: string;
  provider: string;
  quality: string; // "auto" | "720p" | "1080p" | "2160p" etc.
  label: string; // display label
  type: "hls" | "mp4" | "dash";
  maxHeight?: number; // best known resolution for UI badges (0 = probed but unknown)
  /** Desc-sorted rendition heights from a probed HLS/DASH master, e.g. [1080,720,480]. Omitted/empty for single-rendition or mp4. */
  ladder?: number[];
  /** How maxHeight/ladder was obtained — scraper provenance for ranking honesty. */
  qualitySource?: "manifest" | "label" | "probe" | "unknown";
  /** Detected from upstream URL before proxy rewrite (proxy URL hides codec path). */
  codec?: "h264" | "hevc" | "av1" | "unknown";
  /**
   * Actual container format, when known. Debrid sources always drop MKV/WebM
   * before ever becoming a PlaybackSource (see
   * src/lib/playback/debrid/torrentio.ts `isBrowserPlayableContainer` +
   * index.ts) — a source that reaches the client is always mp4/mov, or
   * "unknown" when the container couldn't be determined (heuristic honesty,
   * never invented). Optional/additive so existing embed sources are
   * unaffected.
   */
  container?: "mp4" | "mkv" | "webm" | "mov" | "unknown";
  /** Present after full scrape latency probe; drives measured ranking when ok. */
  probe?: SourceProbeMetrics;
  /**
   * false = soft-kept after failed segment verify (manual switch only).
   * true/undefined = eligible for auto-default when no better probe exists.
   */
  verified?: boolean;
  /**
   * Where this source came from. Unset/"embed" = the free scraper/embed
   * roster (all existing sources — no back-fill needed). "debrid" = resolved
   * via the owner's Real-Debrid account through Torrentio
   * (see src/lib/playback/debrid/). Optional so existing code paths are
   * unaffected.
   */
  origin?: "embed" | "debrid";
  /**
   * Browser decode compatibility for debrid sources: "native" plays in any
   * Chromium/Firefox browser (H.264 progressive MP4/MOV, no HDR). "safari"
   * means the release is HEVC/AV1 or HDR/DV IN AN OTHERWISE BROWSER-LEGAL
   * CONTAINER (MP4/MOV) — only Safari (AVFoundation) reliably decodes it.
   * IMPORTANT: MKV is NOT Safari-playable — no browser, including Safari,
   * can play the MKV container regardless of the codec inside it. This is
   * why MKV sources are dropped entirely rather than ever tagged "safari"
   * (see the container-drop filter in
   * src/lib/playback/debrid/torrentio.ts + index.ts). Unset for embed
   * sources, which are always treated as natively playable.
   */
  compat?: "native" | "safari";
}

export interface PlaybackResponse {
  status: PlaybackStatus;
  streamUrl?: string;
  sources?: PlaybackSource[];
  poster?: string;
  title?: string;
  action?: {
    label: string; // "Request on Radarr" / "Watch on Netflix"
    url?: string; // external link if action is "external"
    requestEndpoint?: string; // internal API to fire a request
  };
  message?: string; // human-readable explanation
  providerId?: string; // which provider resolved this
  /** True when background enrich may still add sources (soft-miss / progressive). */
  partial?: boolean;
}

export interface PlaybackProvider {
  id: string;
  name: string;
  resolve(req: PlaybackRequest): Promise<PlaybackResponse>;
}
