/**
 * CineHome transcode worker — converts a direct video file (debrid/embed URL)
 * into a real, switchable HLS ABR ladder using libx264 software encode, with
 * an OPTIONAL VAAPI hardware DECODE fast path (never VAAPI encode — see
 * ladder.ts's module docstring for why).
 *
 * WHY: ~95% of 4K/high-quality sources are HEVC/HDR, which Chrome and Firefox
 * cannot decode. This worker re-encodes them to H.264 HLS so every browser can
 * play them, with a multi-rung ladder (1080/720/480, capped by the source's
 * native height) so hls.js does seamless adaptive bitrate just like
 * Netflix/YouTube.
 *
 * DECODE STRATEGY:
 *   - VAAPI hardware decode (AMD iGPU, /dev/dri/renderD128) is attempted
 *     FIRST when the device is present — the owner measured ~13 CPU cores for
 *     software-decoding a 4K HEVC source alone, before any encode work even
 *     starts. Moving just decode onto the iGPU captures most of that win.
 *   - Encode is ALWAYS libx264 (software), for every rung, VAAPI or not — a
 *     single shared iGPU encoder driving N simultaneous ABR rungs is a
 *     known-fragile pattern; libx264 gives mature, well-tested multi-output
 *     ABR at the cost of encode staying CPU-bound.
 *   - Toggle: set TRANSCODER_VAAPI_DECODE=false to force software decode
 *     everywhere (e.g. while the boss is isolating a VAAPI regression on the
 *     box) without touching code.
 *
 * FALLBACK CHAIN (playback must NEVER die): VAAPI-decode ladder ->
 * software-decode ladder -> single-rung (<=480p) software. Each attempt runs
 * ffmpeg and races "master.m3u8 appears" against "process exits without
 * producing one"; on failure the attempt's output dir is wiped and the next,
 * simpler attempt starts. The last attempt has no separate startup timeout —
 * it is the guaranteed-simplest shape and the last resort.
 *
 * SAFETY:
 *   - Concurrency-capped (VAAPI is a single shared decoder — serialize heavy
 *     jobs; see TRANSCODER_MAX_CONCURRENT).
 *   - Disk-bounded (TTL cleanup; hard byte cap).
 *   - Every failure degrades to "return null"/502 so the player falls back to
 *     the original direct URL (Safari/HW-Chrome) or another source — never a
 *     hang.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_SEGMENT_DURATION_S,
  buildFfmpegArgs,
  computeRungs,
  extractVariantPlaylistNames,
  type LadderRung,
} from "./ladder";

const PORT = Number(process.env.TRANSCODER_PORT || 3040);
const CACHE_DIR = process.env.TRANSCODER_CACHE_DIR || "/app/transcode-cache";
const VA_API_DEVICE = process.env.TRANSCODER_VAAPI_DEVICE || "/dev/dri/renderD128";
/** Easy kill switch for the VAAPI decode fast path — flip to "false" to force
 * software decode everywhere without a code change. Defaults on. */
const VAAPI_DECODE_ENABLED = process.env.TRANSCODER_VAAPI_DECODE !== "false";
/** Max concurrent transcodes (VAAPI serializes; keep low to avoid decoder contention). */
const MAX_CONCURRENT = Number(process.env.TRANSCODER_MAX_CONCURRENT || 1);
/** Cache entry TTL — popular titles stay warm; stale ones get reclaimed. */
const CACHE_TTL_MS = Number(process.env.TRANSCODER_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
/** Hard disk cap for the whole cache. */
const CACHE_MAX_BYTES = Number(
  process.env.TRANSCODER_CACHE_MAX_BYTES || 50 * 1024 * 1024 * 1024
);
/** Per-segment duration (seconds) — shorter = faster startup, more requests. */
const SEGMENT_DURATION_S = Number(
  process.env.TRANSCODER_SEGMENT_S || DEFAULT_SEGMENT_DURATION_S
);
/** Ceiling for the guaranteed-simplest final fallback rung — always resolves
 * to exactly one rung via computeRungs (see ladder.test.ts). */
const FALLBACK_MAX_HEIGHT = 480;
/** How long a VAAPI-decode attempt gets to either produce master.m3u8 or
 * exit before we give up on it and fall back to software decode. VAAPI
 * failures (bad device, driver init failure) surface fast; this just bounds
 * the "hung, doing nothing" case. */
const VAAPI_ATTEMPT_TIMEOUT_MS = 15_000;
/** Startup budget for the software multi-rung attempt before we give up and
 * drop to the guaranteed single-rung shape. Generous — software decode is the
 * reliable path and cold 4K inputs (slow CDN + decode warmup) legitimately
 * take a while to produce a first segment. */
const SOFTWARE_ATTEMPT_TIMEOUT_MS = 30_000;
/** Overall budget the HTTP layer waits for a playlist to become ready. */
const PLAYLIST_READY_BUDGET_MS = 60_000;

/** In-progress transcodes — concurrent requests for the same key share the result. */
const inflight = new Map<string, Promise<string>>();
/** Active ffmpeg child processes (for cleanup on shutdown). */
const activeProcs = new Set<ChildProcess>();

function log(msg: string): void {
  console.log(`[transcoder] ${msg}`);
}

function sourceKey(inputUrl: string, maxHeight: number): string {
  return createHash("sha256").update(`${inputUrl}|${maxHeight}`).digest("hex").slice(0, 24);
}

function cacheDir(key: string): string {
  return join(CACHE_DIR, key);
}

function playlistPath(key: string): string {
  return join(cacheDir(key), "master.m3u8");
}

/**
 * Probe the source's native height so we don't upscale or build rungs above
 * it. Uses ffprobe (ships with ffmpeg). Returns 0 on failure (caller falls
 * back to a maxHeight-capped full ladder — see `computeRungs`).
 */
function probeHeight(inputUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=height",
      "-of", "csv=p=0",
      "-protocol_whitelist", "https,tls,tcp,http,crypto",
      inputUrl,
    ], { timeout: 15_000 });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(0));
    proc.on("close", (code) => {
      const h = parseInt(out.trim(), 10);
      resolve(code === 0 && Number.isFinite(h) && h > 0 ? h : 0);
    });
  });
}

/**
 * Probe whether the source has an audio stream at all. Fails CLOSED (treats
 * probe failure/timeout the same as "no audio found"): guessing "has audio"
 * wrong makes `-var_stream_map` reference an audio output that doesn't exist
 * and fails the WHOLE transcode; guessing "no audio" wrong just produces a
 * silent (but otherwise fully playable) ladder. Silent-but-working beats
 * broken every time here.
 */
function probeHasAudio(inputUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      "-protocol_whitelist", "https,tls,tcp,http,crypto",
      inputUrl,
    ], { timeout: 15_000 });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

/**
 * One ffmpeg transcode attempt: spawn with the given args, race "master.m3u8
 * appears on disk" against "process exits without ever producing one" and
 * (except for the final, timeout-less attempt) an attempt-local startup
 * timeout. Resolves `{ proc }` on success (the process is left running — the
 * live/incremental ladder keeps writing segments in the background) or
 * `null` on failure (the caller wipes outDir and tries the next attempt).
 */
function attemptTranscode(
  label: string,
  key: string,
  outDir: string,
  args: string[],
  timeoutMs: number | null
): Promise<ChildProcess | null> {
  mkdirSync(outDir, { recursive: true });
  const proc = spawn("ffmpeg", args, { timeout: 4 * 60 * 60 * 1000 });
  activeProcs.add(proc);
  log(`ffmpeg attempt=${label} key=${key} pid=${proc.pid}`);

  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d.toString()));

  return new Promise((resolve) => {
    let settled = false;
    const path = playlistPath(key);
    const pollMs = 300;

    const finish = (result: ChildProcess | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      if (timer) clearTimeout(timer);
      if (result === null) {
        activeProcs.delete(proc);
        proc.kill("SIGKILL");
      }
      resolve(result);
    };

    const poller = setInterval(() => {
      if (existsSync(path)) finish(proc);
    }, pollMs);

    proc.on("error", (err) => {
      log(`attempt=${label} key=${key} spawn error: ${err.message}`);
      finish(null);
    });
    proc.on("close", (code) => {
      // Process exited — success only if it left a playlist behind before
      // dying (e.g. a live ladder that finished cleanly, or one that failed
      // late but still wrote something usable).
      if (existsSync(path)) {
        finish(proc);
      } else {
        log(`attempt=${label} key=${key} exited ${code} with no playlist: ${stderr.slice(-400)}`);
        finish(null);
      }
      activeProcs.delete(proc);
    });

    const timer = timeoutMs
      ? setTimeout(() => {
          log(`attempt=${label} key=${key} timed out after ${timeoutMs}ms with no playlist`);
          finish(null);
        }, timeoutMs)
      : null;
  });
}

function wipeOutDir(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
}

/**
 * Run the transcode via the fallback chain: VAAPI-decode ladder ->
 * software-decode ladder -> single-rung (<=480p) software. Resolves to the
 * playlist path once an attempt succeeds; rejects only if every attempt
 * (including the guaranteed single-rung shape) fails.
 */
async function runTranscode(
  key: string,
  inputUrl: string,
  fullRungs: LadderRung[],
  fallbackRungs: LadderRung[],
  hasAudio: boolean
): Promise<string> {
  const outDir = cacheDir(key);
  const rungHeights = (r: LadderRung[]) => r.map((x) => x.height).join("/");

  type Attempt = { label: string; rungs: LadderRung[]; useVaapi: boolean; timeoutMs: number | null };
  const attempts: Attempt[] = [];
  if (VAAPI_DECODE_ENABLED && existsSync(VA_API_DEVICE)) {
    attempts.push({ label: "vaapi-decode", rungs: fullRungs, useVaapi: true, timeoutMs: VAAPI_ATTEMPT_TIMEOUT_MS });
  }
  attempts.push({ label: "software", rungs: fullRungs, useVaapi: false, timeoutMs: SOFTWARE_ATTEMPT_TIMEOUT_MS });
  // Skip the dedicated fallback attempt when it would be identical to the
  // software attempt above (source already resolves to a single <=480 rung).
  if (fullRungs.length > 1 || fullRungs[0]?.height !== fallbackRungs[0]?.height) {
    attempts.push({ label: "fallback-single-rung", rungs: fallbackRungs, useVaapi: false, timeoutMs: null });
  }

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const isLast = i === attempts.length - 1;
    const plan = buildFfmpegArgs({
      inputUrl,
      outDir,
      rungs: attempt.rungs,
      useVaapi: attempt.useVaapi,
      vaapiDevice: VA_API_DEVICE,
      hasAudio,
      segmentDurationS: SEGMENT_DURATION_S,
    });
    log(
      `${key} attempt ${i + 1}/${attempts.length} (${attempt.label}) rungs=${rungHeights(attempt.rungs)} vaapi=${attempt.useVaapi}`
    );
    const proc = await attemptTranscode(
      attempt.label,
      key,
      outDir,
      plan.args,
      isLast ? null : attempt.timeoutMs
    );
    if (proc) {
      trackCompletion(key, proc);
      return playlistPath(key);
    }
    wipeOutDir(outDir);
  }

  throw new Error(`all transcode attempts failed for key=${key}`);
}

/** Clear `inflight` whichever way the winning attempt's process eventually exits. */
function trackCompletion(key: string, proc: ChildProcess): void {
  const clear = () => inflight.delete(key);
  if (proc.exitCode !== null) {
    clear();
    return;
  }
  proc.once("close", clear);
  proc.once("error", clear);
}

/**
 * Wait until the playlist file exists on disk AND, for a multi-rung ladder,
 * its first variant playlist also exists — ffmpeg writes master.m3u8 as soon
 * as stream mapping is resolved, which can be before any variant sub-playlist
 * has a single segment. Handing back a master whose first variant 404s is as
 * bad as no playlist at all. Returns the path on success, rejects on timeout.
 */
async function waitForPlaylist(key: string, budgetMs: number): Promise<string> {
  const path = playlistPath(key);
  const dir = cacheDir(key);
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (existsSync(path)) {
      let master = "";
      try {
        master = readFileSync(path, "utf8");
      } catch {
        master = "";
      }
      const variants = extractVariantPlaylistNames(master);
      if (variants.length === 0 || existsSync(join(dir, variants[0]!))) {
        return path;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`playlist not ready within ${budgetMs}ms`);
}

/**
 * Get-or-build the HLS playlist for a source. Returns the playlist path.
 * Concurrent requests for the same key share a single transcode.
 */
async function getOrBuild(
  inputUrl: string,
  maxHeight: number
): Promise<string> {
  const key = sourceKey(inputUrl, maxHeight);

  // Cache hit — ladder already built (transcode complete).
  const cached = playlistPath(key);
  if (existsSync(cached) && !inflight.has(key)) {
    return cached;
  }

  // Already building? Don't start a second ffmpeg for the same key.
  const existing = inflight.get(key);
  if (existing) {
    // Swallow — the work promise only tracks completion; we return early below.
    existing.catch(() => {});
  } else {
    const [sourceH, hasAudio] = await Promise.all([probeHeight(inputUrl), probeHasAudio(inputUrl)]);
    const fullRungs = computeRungs(sourceH, maxHeight);
    const fallbackRungs = computeRungs(sourceH, FALLBACK_MAX_HEIGHT);

    // Fire the transcode WITHOUT awaiting — the winning attempt runs in the
    // background and writes the playlist incrementally. We resolve below
    // once the playlist (and its first variant, if any) exists.
    const work = runTranscode(key, inputUrl, fullRungs, fallbackRungs, hasAudio).catch((e) => {
      log(`background transcode failed key=${key}: ${e instanceof Error ? e.message : e}`);
      inflight.delete(key);
      throw e;
    });
    inflight.set(key, work);
  }

  // LIVE: return as soon as the playlist (and first variant) exists, so the
  // player can start on the first segment while transcode continues. Budget
  // covers input-open (slow RD CDN) + decode warmup + the fallback chain's
  // own attempt timeouts on cold 4K inputs.
  return waitForPlaylist(key, PLAYLIST_READY_BUDGET_MS);
}

// ── Cache management ──────────────────────────────────────────────────────

function cacheBytes(): number {
  let total = 0;
  try {
    for (const dir of readdirSync(CACHE_DIR)) {
      const d = join(CACHE_DIR, dir);
      for (const f of readdirSync(d)) {
        try {
          total += statSync(join(d, f)).size;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

/** Remove cache entries older than TTL, then enforce the byte cap (LRU-ish). */
function cleanupCache(): void {
  try {
    const now = Date.now();
    const entries: { dir: string; mtime: number; size: number }[] = [];
    for (const dir of readdirSync(CACHE_DIR)) {
      const d = join(CACHE_DIR, dir);
      try {
        const st = statSync(d);
        let size = 0;
        for (const f of readdirSync(d)) {
          try {
            size += statSync(join(d, f)).size;
          } catch {
            /* ignore */
          }
        }
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          rmSync(d, { recursive: true, force: true });
          log(`TTL-evicted ${dir}`);
        } else {
          entries.push({ dir: d, mtime: st.mtimeMs, size });
        }
      } catch {
        /* ignore */
      }
    }
    // Byte cap: evict oldest until under cap.
    let bytes = entries.reduce((s, e) => s + e.size, 0);
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (bytes <= CACHE_MAX_BYTES) break;
      rmSync(e.dir, { recursive: true, force: true });
      bytes -= e.size;
      log(`cap-evicted ${e.dir}`);
    }
  } catch (e) {
    log(`cleanup error: ${e}`);
  }
}

// Run cleanup periodically + once at boot.
mkdirSync(CACHE_DIR, { recursive: true });
setInterval(cleanupCache, 30 * 60 * 1000).unref();
setTimeout(cleanupCache, 60_000).unref();

// ── HTTP server ───────────────────────────────────────────────────────────

function sendText(res: import("node:http").ServerResponse, code: number, msg: string): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: msg }));
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url || "", `http://localhost:${PORT}`);

  // GET /key?u=<sourceUrl>&maxHeight=<n> → deterministic cache key for the seg
  // route's URL rewriting (the API front needs the key to point segment URLs at
  // /api/transcode/seg?key=...). Pure, no transcode side-effect.
  if (url.pathname === "/key" && req.method === "GET") {
    const inputUrl = url.searchParams.get("u");
    const maxHeight = Number(url.searchParams.get("maxHeight") || "1080");
    if (!inputUrl) return sendText(res, 400, "Missing u (source url)");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ key: sourceKey(inputUrl, maxHeight) }));
    return;
  }

  // GET /transcode?u=<sourceUrl>&maxHeight=<n> → returns the master.m3u8 contents,
  // building it first if needed. The HLS proxy fronts this so segment URLs are
  // rewritten to be player-reachable.
  if (url.pathname === "/transcode" && req.method === "GET") {
    const inputUrl = url.searchParams.get("u");
    const maxHeight = Number(url.searchParams.get("maxHeight") || "1080");
    if (!inputUrl) return sendText(res, 400, "Missing u (source url)");

    try {
      const playlist = await getOrBuild(inputUrl, maxHeight);
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(playlist, "utf8");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`transcode failed for ${inputUrl.slice(0, 50)}: ${msg}`);
      return sendText(res, 502, "transcode failed");
    }
    return;
  }

  // GET /seg/<key>/<file> → serve a cached segment/playlist file.
  if (url.pathname.startsWith("/seg/") && req.method === "GET") {
    const parts = url.pathname.replace("/seg/", "").split("/");
    const key = parts[0];
    const file = parts.slice(1).join("/");
    if (!/^[a-f0-9]{24}$/.test(key) || !/^[\w.-]+$/.test(file)) {
      return sendText(res, 400, "bad path");
    }
    const fp = join(cacheDir(key), file);
    if (!existsSync(fp)) return sendText(res, 404, "not found");
    try {
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(fp);
      const isM3u8 = file.endsWith(".m3u8");
      res.setHeader("Content-Type", isM3u8 ? "application/vnd.apple.mpegurl" : "video/mp2t");
      res.end(body);
    } catch {
      return sendText(res, 500, "read error");
    }
    return;
  }

  // GET /health
  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        port: PORT,
        cacheBytes: cacheBytes(),
        cacheCapBytes: CACHE_MAX_BYTES,
        inflight: inflight.size,
        activeProcs: activeProcs.size,
        vaapiDecodeEnabled: VAAPI_DECODE_ENABLED,
        device: existsSync(VA_API_DEVICE) ? VA_API_DEVICE : null,
        maxConcurrent: MAX_CONCURRENT,
      })
    );
    return;
  }

  sendText(res, 404, "Not found");
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}`);
  log(
    `cache=${CACHE_DIR} ttl=${CACHE_TTL_MS}ms cap=${CACHE_MAX_BYTES} maxConcurrent=${MAX_CONCURRENT} vaapiDecode=${VAAPI_DECODE_ENABLED}`
  );
});

const shutdown = async () => {
  for (const p of activeProcs) p.kill("SIGTERM");
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
