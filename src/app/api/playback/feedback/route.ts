import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import type { PlayerFeedbackEvent } from "@/lib/playback/types";
import { providerHealthRegistry } from "@/lib/playback/health-registry";

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
  console.info(
    JSON.stringify({
      event: "player_feedback",
      feedbackEvent: event,
      userId,
      sourceId,
      provider,
      occurredAt: finite(body.occurredAt, Date.now() + 60_000) ?? Date.now(),
      timeToFirstFrameMs: finite(body.timeToFirstFrameMs, 180_000),
      decodedHeight: finite(body.decodedHeight, 4320),
      reason:
        typeof body.reason === "string" ? body.reason.slice(0, 120) : undefined,
    })
  );
  providerHealthRegistry.observe(
    { provider },
    {
      event,
      sourceId,
      provider,
      occurredAt: finite(body.occurredAt, Date.now() + 60_000) ?? Date.now(),
      timeToFirstFrameMs: finite(body.timeToFirstFrameMs, 180_000),
      decodedHeight: finite(body.decodedHeight, 4320),
      reason:
        typeof body.reason === "string" ? body.reason.slice(0, 120) : undefined,
    }
  );
  return new NextResponse(null, { status: 204 });
}
