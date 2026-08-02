import type { PlayerFeedback } from "./types";
import { platformSummary } from "./device-profile";

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
