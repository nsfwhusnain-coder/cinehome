import type { PlayerFeedback } from "./types";
import { platformSummary } from "./device-profile";

/** Which title the open player is showing. See {@link setFeedbackTitleContext}. */
export interface FeedbackTitleContext {
  tmdbId?: string;
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
}

let titleContext: FeedbackTitleContext = {};

/**
 * Stamp every subsequent emission with the title being watched.
 *
 * Set centrally rather than threaded through each call site: source memory is
 * per-title, and the six existing emitters live deep inside the player's
 * attempt/watchdog machinery where adding four more arguments each would be
 * far more likely to break something than a single module-level assignment.
 * Cleared on teardown so a stale title can never mislabel the next session.
 */
export function setFeedbackTitleContext(context: FeedbackTitleContext): void {
  titleContext = context;
}

export function clearFeedbackTitleContext(): void {
  titleContext = {};
}

/** Best-effort observation channel. Playback never waits for telemetry. */
export function emitPlayerFeedback(
  feedback: Omit<PlayerFeedback, "occurredAt">
): void {
  if (typeof window === "undefined") return;
  // Stamped here rather than at each call site: every emitter gets device
  // attribution for free, and without it a television session is
  // indistinguishable from a laptop one in the logs — which is precisely why
  // cross-device playback differences went unnoticed in production.
  const platform = platformSummary();
  const body = JSON.stringify({
    ...titleContext,
    ...feedback,
    ...(platform ? { platform } : {}),
    occurredAt: Date.now(),
  });
  try {
    if (typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(
        "/api/playback/feedback",
        new Blob([body], { type: "application/json" })
      );
      if (sent) return;
    }
    void fetch("/api/playback/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    // Telemetry must be unable to affect playback.
  }
}
