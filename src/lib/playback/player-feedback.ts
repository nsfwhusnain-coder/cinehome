import type { PlayerFeedback } from "./types";

/** Best-effort observation channel. Playback never waits for telemetry. */
export function emitPlayerFeedback(
  feedback: Omit<PlayerFeedback, "occurredAt">
): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({ ...feedback, occurredAt: Date.now() });
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
