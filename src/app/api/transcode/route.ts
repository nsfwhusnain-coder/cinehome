import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { resolveFullRoster } from "@/lib/playback/resolve-full";
import { rewritePlaylist } from "@/lib/playback/transcode-playlist";

/**
 * Legacy transcode front — retained for isolated redesign/testing, but
 * production-disabled unless TRANSCODER_ENABLED is exactly "1". The current
 * whole-file worker has no safe shared-host resource envelope.
 *
 * Two routes:
 *   GET /api/transcode?type=&id=&sourceId=&maxHeight=
 *     → returns the master.m3u8, rewriting segment URLs to be browser-reachable
 *       via the seg route below. Builds the ladder (live) if not cached.
 *
 *   GET /api/transcode/seg?key=<24hex>&f=<file>
 *     → serves a transcode-cache segment/playlist file. The key is opaque to the
 *       client (a sha256 prefix of the source URL + height); it carries no token
 *       and no title identity.
 *
 * Security: the source's upstream URL never reaches the client. The transcoder
 * fetches it in-container and returns a token-free H.264 HLS ladder. Segment
 * files are served by opaque cache key only — no path traversal possible
 * (strict regex validation in the transcoder + here).
 */
const TRANSCODER_URL =
  process.env.TRANSCODER_INTERNAL_URL || "http://127.0.0.1:3040";
// Must exceed the transcoder's playlist-ready budget (60s) — cold 4K HEVC
// inputs need input-open + decode warmup before the first segment lands.
const TRANSCODER_TIMEOUT_MS = 75_000;

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  /**
   * Two modes, gated independently because their cost is not remotely
   * comparable.
   *
   * `remux` is a container rewrite with `-c copy`: no decode, no encode.
   * Measured on this host, 60s of 3840x2160 10-bit AV1 rewrapped in 6s wall.
   * It is what makes MKV releases playable at all - MKV opens in no browser,
   * Safari included, even when the streams inside (AV1, H.264, Opus) are ones
   * the browser decodes natively. Default ON.
   *
   * `transcode` decodes and re-encodes and stays default OFF: a cold 4K HEVC
   * job measured 17.4 GiB and 1378% CPU on this shared box.
   */
  const mode = url.searchParams.get("mode") === "remux" ? "remux" : "transcode";
  const modeEnabled =
    mode === "remux"
      ? process.env.REMUX_ENABLED !== "0"
      : process.env.TRANSCODER_ENABLED === "1";
  if (!modeEnabled) {
    return NextResponse.json(
      {
        error:
          mode === "remux"
            ? "Remuxing is disabled; choose a browser-compatible source"
            : "Server transcoding is unavailable; choose a browser-compatible source",
      },
      { status: 503 }
    );
  }

  // NOTE: segment serving lives in /api/transcode/seg/route.ts — Next.js App
  // Router requires sub-paths to have their own route.ts, so the seg handler
  // can't live here. The playlist we return rewrites segment URLs to point at
  // that route (see rewritePlaylist below).

  // ── Playlist build/fetch ─────────────────────────────────────────────────
  const type = url.searchParams.get("type");
  const id = Number(url.searchParams.get("id"));
  const sourceId = url.searchParams.get("sourceId");
  const maxHeight = Number(url.searchParams.get("maxHeight") || "1080");
  const season = url.searchParams.get("season");
  const episode = url.searchParams.get("episode");

  if (!sourceId || (type !== "movie" && type !== "tv") || !id) {
    return NextResponse.json(
      { error: "Missing type, id, or sourceId" },
      { status: 400 }
    );
  }

  // Re-resolve the FULL roster the same way /api/playback does — base embed
  // sources PLUS the debrid tier merged in. The 4K HEVC/safari debrid sources
  // the transcoder targets are NOT in provider.resolve() alone (debrid is a
  // separate parallel merge in the playback route), so this MUST use the shared
  // resolveFullRoster helper or debrid source ids 404. fast:false so the full
  // debrid roster is included.
  const resolved = await resolveFullRoster({
    userId,
    type: type as "movie" | "tv",
    tmdbId: id,
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
  });

  const source = resolved.sources?.find((s) => s.id === sourceId);
  if (!source) {
    return NextResponse.json(
      { error: "Source not found (may have expired — retry playback)" },
      { status: 404 }
    );
  }

  // Ask the transcoder to build (or fetch cached) the HLS ladder. It returns
  // the master.m3u8 once the first segment exists (live), not after full encode.
  const tcUrl = `${TRANSCODER_URL}/transcode?u=${encodeURIComponent(
    source.url
  )}&maxHeight=${maxHeight}&mode=${mode}`;
  const tcRes = await fetch(tcUrl, {
    signal: AbortSignal.timeout(TRANSCODER_TIMEOUT_MS),
    headers: { Accept: "application/vnd.apple.mpegurl" },
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 502 });
  });

  if (!tcRes.ok) {
    const body = await tcRes.text().catch(() => "");
    return NextResponse.json(
      { error: `transcoder ${tcRes.status}`, detail: body.slice(0, 200) },
      { status: 502 }
    );
  }

  // Rewrite relative segment URLs to be browser-reachable through this route.
  // The transcoder emits seg_00000.ts; we point them at /api/transcode/seg.
  // We also need the cache key for the seg route — ask the transcoder for it.
  const rawPlaylist = await tcRes.text();
  const keyResp = await fetch(
    `${TRANSCODER_URL}/key?u=${encodeURIComponent(source.url)}&maxHeight=${maxHeight}&mode=${mode}`,
    { signal: AbortSignal.timeout(5_000) }
  ).catch(() => null);
  let cacheKey = "";
  if (keyResp && keyResp.ok) {
    try {
      cacheKey = (await keyResp.json()).key || "";
    } catch {
      /* ignore */
    }
  }
  if (!cacheKey) {
    // Without the key we can't rewrite segment URLs — return the raw playlist
    // (segments unreachable from browser). The player will fail over to direct.
    return new NextResponse(rawPlaylist, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }

  // Rewrites master.m3u8's own lines. For a multi-rung ladder those lines are
  // the vN.m3u8 variant sub-playlists (not segments) — the seg route below
  // rewrites AGAIN inside each variant playlist's own contents, since its
  // segment references still need pointing at the seg proxy too.
  const rewritten = rewritePlaylist(rawPlaylist, cacheKey);
  return new NextResponse(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
    },
  });
}
