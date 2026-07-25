import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { decodeUpstream, getHlsSession } from "@/lib/hls-session";
import { fetchProxied, isAllowedUpstreamUrl } from "@/lib/hls-proxy";

/**
 * GET /api/hls/{sessionId}?u={base64url_upstream_url}
 * Proxies HLS manifests (rewritten) and media segments with embed auth headers.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  const hlsSession = getHlsSession(sessionId);
  if (!hlsSession) {
    return NextResponse.json({ error: "Session expired — retry playback" }, { status: 410 });
  }

  if (hlsSession.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const encoded = req.nextUrl.searchParams.get("u");
  if (!encoded) {
    return NextResponse.json({ error: "Missing upstream URL" }, { status: 400 });
  }

  let upstream: string;
  try {
    upstream = decodeUpstream(encoded);
  } catch {
    return NextResponse.json({ error: "Invalid upstream URL" }, { status: 400 });
  }

  if (!isAllowedUpstreamUrl(upstream, hlsSession)) {
    return NextResponse.json({ error: "Forbidden upstream URL" }, { status: 403 });
  }

  const rangeHeader = req.headers.get("range");
  // `media=1` marks the child of a synthetic single-rung master — skip re-wrap.
  const skipMediaWrap = req.nextUrl.searchParams.get("media") === "1";
  const proxied = await fetchProxied(hlsSession, upstream, rangeHeader, req.signal, {
    skipMediaWrap,
  });
  return proxied;
}