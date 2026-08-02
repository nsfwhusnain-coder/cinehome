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
 *   - Disk-bounded (TTL cleanup; hard byte cap; entries in use are never
 *     evicted). The remux path additionally refuses to start below a free-space
 *     floor and kills any single job that exceeds a per-job cap, because a
 *     stream copy writes its input back out roughly 1:1.
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
  statfsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { AudioPreference } from "../../src/lib/profile-preferences";
import {
  selectAudioTrack,
  type AudioTrackSelection,
  type SelectableMediaTrack,
} from "../../src/lib/playback/track-selection";
import {
  DEFAULT_SEGMENT_DURATION_S,
  buildFfmpegArgs,
  computeRungs,
  extractVariantPlaylistNames,
  type LadderRung,
  buildRemuxArgs,
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

/**
 * Disk safety for the remux path.
 *
 * A stream copy writes the source back out roughly 1:1, so remuxing a 4K
 * release means tens of GB on disk - a completely different disk profile from
 * the re-encode ladder, whose 1080p H.264 output is a fraction of its input.
 * The host runs at 87% full, and `cleanupCache` only sweeps every 30 minutes,
 * so without an admission gate two concurrent 4K remuxes can exhaust the
 * volume long before eviction ever looks.
 *
 * REMUX_MIN_FREE_BYTES  refuse to START a remux below this much free space
 *                       (after trying a cleanup first). The player treats the
 *                       error as a source failure and fails over, which is the
 *                       right outcome: another source beats a full disk.
 * REMUX_MAX_JOB_BYTES   kill a single remux whose output exceeds this. Sized
 *                       above any realistic streamable 4K encode (those run
 *                       6-20 GB); it exists to stop a pathological input - a
 *                       60 GB BluRay remux, or an upstream that never EOFs -
 *                       from eating the volume on its own.
 */
const REMUX_MIN_FREE_BYTES = Number(
  process.env.TRANSCODER_REMUX_MIN_FREE_BYTES || 25 * 1024 * 1024 * 1024
);
const REMUX_MAX_JOB_BYTES = Number(
  process.env.TRANSCODER_REMUX_MAX_JOB_BYTES || 30 * 1024 * 1024 * 1024
);
/** How often a running remux's output size is checked against the cap. */
const REMUX_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * Kill a remux nobody is watching.
 *
 * ffmpeg runs at roughly 10x realtime, so it races far ahead of the viewer and
 * keeps going after they navigate away — measured on a single abandoned 4K
 * playback: 4.5 GB written within a minute of the tab closing, with the job
 * still running and headed for the full file. The cache cap would eventually
 * reclaim it, but only after the write had already happened, which is the
 * expensive part on a volume at 88%.
 *
 * A player requests segments continuously while playing and stops the moment
 * it is closed, so "no segment read recently" is a direct signal. Two minutes
 * is long enough to survive a pause with a full buffer, short enough to bound
 * an abandoned job. Output is wiped rather than kept: a killed stream copy
 * leaves a playlist that just stops partway through, and serving that later as
 * a cache hit would silently truncate the film.
 */
const REMUX_IDLE_TIMEOUT_MS = 120_000;
const REMUX_IDLE_CHECK_INTERVAL_MS = 30_000;
/**
 * Concurrent remux ceiling, ENFORCED — unlike TRANSCODER_MAX_CONCURRENT, which
 * was declared and reported in /health but never actually checked anywhere.
 * Two households watching two different 4K titles is the realistic ceiling
 * here; beyond that the shared upstream link is the bottleneck and every
 * stream suffers. Over capacity the request is refused rather than queued, so
 * the player fails over to another source immediately instead of sitting on a
 * manifest that will not arrive.
 */
const REMUX_MAX_CONCURRENT = Number(process.env.TRANSCODER_REMUX_MAX_CONCURRENT || 2);

/** Keys with a remux ffmpeg currently running. */
const activeRemuxes = new Set<string>();
/**
 * A cache entry is protected from eviction for this long after its last read.
 * Without it, eviction is free to delete the very directory a viewer is
 * streaming from - the entry is oldest by mtime precisely BECAUSE it was
 * built first, which is not the same as being unused.
 */
const CACHE_ACTIVE_GRACE_MS = 30 * 60 * 1000;

/** Last read time per cache key, for the eviction guard above. */
const lastAccess = new Map<string, number>();

function touchKey(key: string): void {
  lastAccess.set(key, Date.now());
}

/** In-progress transcodes — concurrent requests for the same key share the result. */
const inflight = new Map<string, Promise<string>>();
/** Active ffmpeg child processes (for cleanup on shutdown). */
const activeProcs = new Set<ChildProcess>();

function log(msg: string): void {
  console.log(`[transcoder] ${msg}`);
}

/**
 * Cache identity. `mode` participates so a remux and a transcode of the SAME
 * source never share an output directory - they produce different containers
 * (fMP4 vs TS) and different playlists, and colliding them would serve a
 * half-written mixture.
 */
function sourceKey(
  inputUrl: string,
  maxHeight: number,
  mode: BuildMode = "transcode",
  audioSelection: AudioTrackSelection = DEFAULT_REMUX_AUDIO_SELECTION
): string {
  // Height is dropped from a remux's identity because a remux HAS no target
  // height - it copies the bitstream, so the output is the source resolution
  // whatever the caller asked for. Keeping it in would let two requests for the
  // same rewrap land on different keys and rebuild the same output twice.
  const heightPart = mode === "remux" ? "copy" : String(maxHeight);
  const audioPart =
    mode === "remux"
      ? `${audioSelection.preference}|${audioSelection.originalLanguage ?? ""}|${audioSelection.preferredLanguage ?? ""}`
      : "default";
  return createHash("sha256")
    .update(`${inputUrl}|${heightPart}|${mode}|${audioPart}`)
    .digest("hex")
    .slice(0, 24);
}

export type BuildMode = "transcode" | "remux";

const DEFAULT_REMUX_AUDIO_SELECTION: AudioTrackSelection = {
  preference: "original",
  originalLanguage: null,
  preferredLanguage: "en",
};

function parseMode(raw: string | null): BuildMode {
  return raw === "remux" ? "remux" : "transcode";
}

function parseAudioPreference(raw: string | null): AudioPreference {
  return raw === "english" || raw === "preferred" ? raw : "original";
}

function safeLanguage(raw: string | null): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) ? value : null;
}

function parseAudioSelection(url: URL): AudioTrackSelection {
  return {
    preference: parseAudioPreference(url.searchParams.get("audioPreference")),
    originalLanguage: safeLanguage(url.searchParams.get("originalLanguage")),
    preferredLanguage: safeLanguage(url.searchParams.get("audioLanguage")) ?? "en",
  };
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
 * Bounded metadata-only audio probe for remux track choice. The remote file is
 * never decoded; ffprobe reads just enough container metadata to enumerate
 * audio streams. A slow/malformed source falls back to audio stream zero so
 * track preference can never make an otherwise playable remux unavailable.
 */
function probePreferredAudioStream(
  inputUrl: string,
  selection: AudioTrackSelection
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index:stream_tags=language,title:stream_disposition=default",
        "-of",
        "json",
        "-protocol_whitelist",
        "https,tls,tcp,http,crypto",
        inputUrl,
      ],
      { timeout: 5_000 }
    );
    let out = "";
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("error", () => finish(0));
    proc.on("close", (code) => {
      if (code !== 0) return finish(0);
      try {
        const parsed = JSON.parse(out) as {
          streams?: Array<{
            tags?: { language?: string; title?: string };
            disposition?: { default?: number };
          }>;
        };
        const tracks: SelectableMediaTrack[] = (parsed.streams ?? []).map(
          (stream, ordinal) => ({
            id: ordinal,
            lang: stream.tags?.language,
            name: stream.tags?.title,
            default: stream.disposition?.default === 1,
          })
        );
        finish(selectAudioTrack(tracks, selection)?.id ?? 0);
      } catch {
        finish(0);
      }
    });
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

/**
 * Bound a running remux's disk footprint. A stream copy writes ~1:1, so the
 * only thing standing between a pathological input and a full volume is this.
 * Killing ffmpeg leaves the segments already written intact and playable, so
 * an over-cap title degrades to "plays up to the cap" rather than to nothing.
 */
function watchRemuxSize(proc: ChildProcess, outDir: string, key: string): void {
  const timer = setInterval(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      clearInterval(timer);
      return;
    }
    const bytes = dirBytes(outDir);
    if (bytes > REMUX_MAX_JOB_BYTES) {
      clearInterval(timer);
      log(
        `remux key=${key} hit the per-job cap (${bytes} > ${REMUX_MAX_JOB_BYTES} bytes); stopping ffmpeg`
      );
      proc.kill("SIGKILL");
    }
  }, REMUX_WATCHDOG_INTERVAL_MS);
  timer.unref();
  proc.once("close", () => clearInterval(timer));
}

/** See REMUX_IDLE_TIMEOUT_MS — stop writing for a viewer who has gone. */
function watchRemuxIdle(proc: ChildProcess, outDir: string, key: string): void {
  const timer = setInterval(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      clearInterval(timer);
      return;
    }
    const idleMs = Date.now() - (lastAccess.get(key) ?? 0);
    if (idleMs > REMUX_IDLE_TIMEOUT_MS) {
      clearInterval(timer);
      log(`remux key=${key} idle for ${idleMs}ms; stopping ffmpeg and discarding partial output`);
      proc.kill("SIGKILL");
      // Wipe on the close handler, not here, so ffmpeg has released its files.
      proc.once("close", () => {
        inflight.delete(key);
        lastAccess.delete(key);
        wipeOutDir(outDir);
      });
      // Already exited between the check and the kill.
      if (proc.exitCode !== null) {
        inflight.delete(key);
        lastAccess.delete(key);
        wipeOutDir(outDir);
      }
    }
  }, REMUX_IDLE_CHECK_INTERVAL_MS);
  timer.unref();
  proc.once("close", () => clearInterval(timer));
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
  maxHeight: number,
  mode: BuildMode = "transcode",
  audioSelection: AudioTrackSelection = DEFAULT_REMUX_AUDIO_SELECTION
): Promise<string> {
  const key = sourceKey(inputUrl, maxHeight, mode, audioSelection);
  touchKey(key);

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
  } else if (mode === "remux") {
    /**
     * Remux needs none of the ladder machinery below: there are no rungs to
     * compute (the bitstream is copied unchanged, so output resolution IS the
     * source resolution), no VAAPI/software fallback chain (nothing is being
     * decoded), and no height probe. One attempt, one ffmpeg, stream copy.
     */
    // Admission control: a stream copy needs room for roughly the whole source
    // file. Try to make room first, then refuse rather than start a job that
    // cannot finish - the app turns this into a 502 and the player fails over
    // to another source, which is a far better outcome than a full volume.
    if (freeBytes() < REMUX_MIN_FREE_BYTES) {
      cleanupCache();
      if (freeBytes() < REMUX_MIN_FREE_BYTES) {
        throw new Error(
          `insufficient disk for remux: ${freeBytes()} free, need ${REMUX_MIN_FREE_BYTES}`
        );
      }
    }
    if (activeRemuxes.size >= REMUX_MAX_CONCURRENT) {
      throw new Error(
        `remux at capacity: ${activeRemuxes.size}/${REMUX_MAX_CONCURRENT} running`
      );
    }
    /**
     * Start from an empty directory, always.
     *
     * `attemptTranscode` only mkdir -p's, so anything left by an earlier run of
     * the SAME key survives — and the key is stable per source, so that is the
     * normal case after an interrupted playback. The result is one directory
     * holding output from two different ffmpeg invocations: `init.mp4` from the
     * new run alongside segments from the old one. They do not share an
     * initialization segment, so MSE rejects the mismatched fragments and the
     * player retries the same segment until it gives up and fails over —
     * measured at ~15s wasted before a 4K source dropped to a 1080p fallback.
     * The ladder path never hit this because it wipes between attempts.
     */
    const outDir = cacheDir(key);
    wipeOutDir(outDir);
    mkdirSync(outDir, { recursive: true });
    const audioStreamIndex = await probePreferredAudioStream(
      inputUrl,
      audioSelection
    );
    const args = buildRemuxArgs({
      inputUrl,
      outDir,
      segmentDurationS: SEGMENT_DURATION_S,
      audioStreamIndex,
    });
    log(
      `${key} remux (stream copy, no video re-encode, audio stream ${audioStreamIndex})`
    );
    const work = (async () => {
      const proc = await attemptTranscode("remux", key, outDir, args, null);
      if (!proc) {
        wipeOutDir(outDir);
        throw new Error(`remux failed for key=${key}`);
      }
      activeRemuxes.add(key);
      proc.once("close", () => activeRemuxes.delete(key));
      watchRemuxSize(proc, outDir, key);
      watchRemuxIdle(proc, outDir, key);
      trackCompletion(key, proc);
      return playlistPath(key);
    })().catch((e) => {
      log(`background remux failed key=${key}: ${e instanceof Error ? e.message : e}`);
      inflight.delete(key);
      throw e;
    });
    inflight.set(key, work);
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

/** Free bytes on the volume backing the cache; 0 when it cannot be read (which
 * fails the admission check closed, the safe direction). */
function freeBytes(): number {
  try {
    const st = statfsSync(CACHE_DIR);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        total += statSync(join(dir, f)).size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

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
        // Never reclaim an entry that is being built or was just read - see
        // CACHE_ACTIVE_GRACE_MS. Applies to both eviction paths below.
        const accessed = lastAccess.get(dir) ?? 0;
        const inUse =
          inflight.has(dir) || now - accessed < CACHE_ACTIVE_GRACE_MS;
        if (inUse) {
          continue;
        }
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          rmSync(d, { recursive: true, force: true });
          lastAccess.delete(dir);
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
      lastAccess.delete(basename(e.dir));
      bytes -= e.size;
      log(`cap-evicted ${e.dir}`);
    }
  } catch (e) {
    log(`cleanup error: ${e}`);
  }
}

/**
 * Drop cache entries that were interrupted mid-write.
 *
 * A cache hit is decided by "master.m3u8 exists", so a directory left behind by
 * a crash, a container restart or a killed job is served as if it were
 * complete — and it is not: the playlist references segments that may be
 * truncated or gone, so the player retries the same segment until it gives up
 * and fails over. Seen live: a leftover directory from an interrupted job cost
 * a 4K source ~15s of retries before it dropped to a 1080p fallback.
 *
 * `#EXT-X-ENDLIST` is the reliable marker. ffmpeg writes it only when the mux
 * finishes cleanly, and nothing is in flight at boot, so a media playlist
 * without one was interrupted. Ladder MASTERS never carry it (they list
 * variants, not segments), so they are identified and left alone.
 */
function purgeIncompleteEntries(): void {
  let removed = 0;
  try {
    for (const dir of readdirSync(CACHE_DIR)) {
      const path = playlistPath(dir);
      if (!existsSync(path)) {
        rmSync(cacheDir(dir), { recursive: true, force: true });
        removed += 1;
        continue;
      }
      let master = "";
      try {
        master = readFileSync(path, "utf8");
      } catch {
        master = "";
      }
      const isLadderMaster = extractVariantPlaylistNames(master).length > 0;
      if (isLadderMaster || master.includes("#EXT-X-ENDLIST")) continue;
      rmSync(cacheDir(dir), { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    /* cache dir may not exist yet */
  }
  if (removed > 0) log(`purged ${removed} incomplete cache entr${removed === 1 ? "y" : "ies"} at boot`);
}

// Run cleanup periodically + once at boot.
mkdirSync(CACHE_DIR, { recursive: true });
purgeIncompleteEntries();
setInterval(cleanupCache, 30 * 60 * 1000).unref();
// A running remux adds gigabytes between those sweeps, so it gets its own
// tighter cadence for as long as anything is actually in flight.
setInterval(() => {
  if (inflight.size > 0) cleanupCache();
}, 2 * 60 * 1000).unref();
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
    const mode = parseMode(url.searchParams.get("mode"));
    const audioSelection = parseAudioSelection(url);
    if (!inputUrl) return sendText(res, 400, "Missing u (source url)");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        key: sourceKey(inputUrl, maxHeight, mode, audioSelection),
      })
    );
    return;
  }

  // GET /transcode?u=<sourceUrl>&maxHeight=<n> → returns the master.m3u8 contents,
  // building it first if needed. The HLS proxy fronts this so segment URLs are
  // rewritten to be player-reachable.
  if (url.pathname === "/transcode" && req.method === "GET") {
    const inputUrl = url.searchParams.get("u");
    const maxHeight = Number(url.searchParams.get("maxHeight") || "1080");
    const mode = parseMode(url.searchParams.get("mode"));
    const audioSelection = parseAudioSelection(url);
    if (!inputUrl) return sendText(res, 400, "Missing u (source url)");

    try {
      const playlist = await getOrBuild(
        inputUrl,
        maxHeight,
        mode,
        audioSelection
      );
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
    // Being read == in use. This is what keeps eviction from deleting the
    // directory a viewer is streaming from (see CACHE_ACTIVE_GRACE_MS).
    touchKey(key);
    try {
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(fp);
      const isM3u8 = file.endsWith(".m3u8");
      // fMP4 (remux: init.mp4 + seg_*.m4s) vs MPEG-TS (re-encode ladder).
      const isFmp4 = file.endsWith(".m4s") || file.endsWith(".mp4");
      res.setHeader(
        "Content-Type",
        isM3u8
          ? "application/vnd.apple.mpegurl"
          : isFmp4
            ? "video/mp4"
            : "video/mp2t"
      );
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
        freeBytes: freeBytes(),
        remuxMinFreeBytes: REMUX_MIN_FREE_BYTES,
        inflight: inflight.size,
        activeProcs: activeProcs.size,
        vaapiDecodeEnabled: VAAPI_DECODE_ENABLED,
        device: existsSync(VA_API_DEVICE) ? VA_API_DEVICE : null,
        maxConcurrent: MAX_CONCURRENT,
        activeRemuxes: activeRemuxes.size,
        remuxMaxConcurrent: REMUX_MAX_CONCURRENT,
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
