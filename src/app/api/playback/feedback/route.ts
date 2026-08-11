import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import type { PlayerFeedbackEvent } from "@/lib/playback/types";
import { providerHealthRegistry } from "@/lib/playback/health-registry";
import { RateLimiter } from "@/lib/rate-limit";

const FEEDBACK_LIMIT = 180;
const FEEDBACK_WINDOW_MS = 5 * 60 * 1000;
const feedbackLimiter = new RateLimiter({
  limit: FEEDBACK_LIMIT,
  windowMs: FEEDBACK_WINDOW_MS,
});

const EVENTS = new Set<PlayerFeedbackEvent>([
  "first_frame",
  "decoded_resolution",
  "stall",
  "handoff_failed",
  "decode_error",
]);

export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rate = feedbackLimiter.consume(userId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many feedback events" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))),
        },
      }
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = body.event as PlayerFeedbackEvent;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 160) : "";
  const provider = typeof body.provider === "string" ? body.provider.slice(0, 80) : "";
  if (!EVENTS.has(event) || !sourceId || !provider) {
    return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
  }
  const finite = (value: unknown, max: number): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.min(number, max)
      : undefined;
  };
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : undefined;
  const engine = new Set(["hlsjs", "native_hls", "native_file", "dash"]).has(
    String(body.engine)
  )
    ? (body.engine as "hlsjs" | "native_hls" | "native_file" | "dash")
    : undefined;
  // Coarse device attribution. Without it a television session and a laptop
  // session are identical in the logs, which is why cross-device playback
  // differences stayed invisible. Never the raw UA — a bounded token only.
  const rawPlatform =
    typeof body.platform === "object" && body.platform !== null
      ? (body.platform as Record<string, unknown>)
      : null;
  const platform = rawPlatform
    ? {
        deviceClass:
          rawPlatform.deviceClass === "tv" ? ("tv" as const) : ("desktop" as const),
        uaPlatform: text(rawPlatform.uaPlatform, 24),
        heapLimitMb: finite(rawPlatform.heapLimitMb, 65_536),
        cores: finite(rawPlatform.cores, 512),
        screenWidth: finite(rawPlatform.screenWidth, 16_384),
      }
    : undefined;

  const feedback = {
    event,
    sourceId,
    provider,
    attemptId: text(body.attemptId, 96),
    occurredAt: finite(body.occurredAt, Date.now() + 60_000) ?? Date.now(),
    timeToFirstFrameMs: finite(body.timeToFirstFrameMs, 180_000),
    decodedHeight: finite(body.decodedHeight, 4320),
    selectedHeight: finite(body.selectedHeight, 4320),
    audioCodec: text(body.audioCodec, 32),
    audioLanguage: text(body.audioLanguage, 32),
    engine,
    errorDetail: text(body.errorDetail, 180),
    reason: text(body.reason, 120),
  };
  console.info(
    JSON.stringify({
      userId,
      ...feedback,
      ...(platform ? { platform } : {}),
      event: "player_feedback",
      feedbackEvent: feedback.event,
    })
  );
  providerHealthRegistry.observe({ provider, viewerId: userId }, feedback);
  return new NextResponse(null, { status: 204 });
}
