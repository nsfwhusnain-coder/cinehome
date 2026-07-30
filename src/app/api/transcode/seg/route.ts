import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { rewritePlaylist } from "@/lib/playback/transcode-playlist";

/**
 * GET /api/transcode/seg?key=<24hex>&f=<file>
 *
 * Serves a legacy transcode-cache segment/playlist file only when the
 * explicitly opt-in transcoder is enabled.
 * (Next.js App Router requires sub-paths to have their own route.ts — the seg
 * handler can't live in the parent /api/transcode/route.ts.)
 *
 * Multi-rung ladders route THROUGH here twice: once for a variant playlist
 * (f=v0.m3u8) and once per segment it references (f=seg_0_00001.ts). A
 * variant playlist's own contents still reference bare segment filenames —
 * those must be rewritten to seg-proxy URLs too, or the browser resolves
 * them relative to this route's path and 404s every segment. Only .m3u8
 * responses get this second rewrite pass; .ts segments are passed through
 * as opaque bytes.
 *
 * Auth-gated: only authenticated users fetch segments. The key is an opaque
 * sha256 prefix of the source URL + height — it carries no token and no title
 * identity, and strict regex validation prevents path traversal.
 */
const TRANSCODER_URL =
  process.env.TRANSCODER_INTERNAL_URL || "http://127.0.0.1:3040";
const SEG_KEY_RE = /^[a-f0-9]{24}$/;
const SEG_FILE_RE = /^[\w.-]+$/;

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  /**
   * Serves segments for BOTH modes. The key is an opaque hash and carries no
   * mode, so this cannot tell a remux segment from a transcode one - gate on
   * "is either mode enabled" and let /api/transcode itself refuse the mode it
   * does not allow. Gating on TRANSCODER_ENABLED alone would have made every
   * remux playlist resolve and then 503 on its first segment.
   */
  const anyModeEnabled =
    process.env.REMUX_ENABLED !== "0" || process.env.TRANSCODER_ENABLED === "1";
  if (!anyModeEnabled) {
    return NextResponse.json(
      { error: "Server media processing is unavailable" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const f = url.searchParams.get("f") || "";

  if (!SEG_KEY_RE.test(key) || !SEG_FILE_RE.test(f)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }

  const tcRes = await fetch(
    `${TRANSCODER_URL}/seg/${key}/${encodeURIComponent(f)}`,
    { signal: AbortSignal.timeout(30_000) }
  ).catch(() => null);

  if (!tcRes || !tcRes.ok) {
    return NextResponse.json({ error: "segment not found" }, { status: 404 });
  }

  const isM3u8 = f.endsWith(".m3u8");
  if (isM3u8) {
    // A variant (or, for a single-rung ladder, flat) media playlist — its
    // own segment references need the same seg-proxy rewrite the master got
    // in /api/transcode, or the browser can't resolve them.
    const text = await tcRes.text();
    const rewritten = rewritePlaylist(text, key);
    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // Never cache: this playlist can still be growing (live/incremental
        // transcode) — a stale cached copy would freeze playback on the
        // first few segments.
        "Cache-Control": "no-store",
      },
    });
  }

  const body = await tcRes.arrayBuffer();
  // The two output shapes have different segment containers and must not be
  // mislabelled: the re-encode ladder emits MPEG-TS (.ts), the remux path emits
  // fMP4 (init.mp4 + seg_*.m4s). Safari's native HLS in particular rejects an
  // fMP4 init segment served as video/mp2t.
  const isFmp4 = f.endsWith(".m4s") || f.endsWith(".mp4");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": isFmp4 ? "video/mp4" : "video/mp2t",
      // Segments are immutable once written (filename is segment index).
      "Cache-Control": "public, max-age=3600",
    },
  });
}
