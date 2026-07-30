/**
 * Pure ABR-ladder logic for the transcode worker — rung selection and ffmpeg
 * argument construction. No spawn, no filesystem, no network: every export
 * here is a deterministic function of its inputs so it can be unit-tested on
 * a machine with no ffmpeg/ffprobe/VAAPI at all (this build machine).
 * `index.ts` owns all the I/O (spawn, probes, caching, fallback sequencing)
 * and calls into this module for the actual argv construction.
 *
 * DECODE/ENCODE STRATEGY — VAAPI hardware DECODE (optional, with a software
 * fallback) + libx264 software ENCODE for every rung (never h264_vaapi
 * encode):
 *   - Decode is where the CPU cost actually lives for 4K/HEVC sources (the
 *     owner's live measurement: ~13 cores decoding alone) — moving JUST
 *     decode onto the iGPU captures the large majority of that win, without
 *     touching the encode side at all.
 *   - A single shared iGPU encoder driving N simultaneous ABR rungs is a
 *     known-fragile pattern (VAAPI encode contexts, driver-specific rate
 *     control quirks, contention on the one hardware encode block this box
 *     has) — libx264 gives mature, well-tested multi-output ABR instead
 *     (per-rung -b:v/-maxrate/-bufsize), at the cost of encode staying
 *     CPU-bound.
 *   - No HDR→SDR tonemap filter chain: it's fragile (only operates on
 *     software frames, multi-stage zscale/tonemap graphs are a common source
 *     of AVERROR_EXTERNAL-class failures) and out of scope here. The
 *     software path just runs `format=yuv420p`, accepting slightly-off HDR
 *     colors — far better than a transcode that fails outright. If real HDR
 *     tonemapping is wanted later, it's a separate, deliberately-scoped
 *     change with its own hardware verification pass.
 *   - Two specific mistakes previously broke this pipeline for hours and
 *     must never be reintroduced:
 *       1. `scale=-2:H:force_original_aspect_ratio=decrease` — that combo
 *          triggers AVERROR_EXTERNAL / libx264 -22. Plain `scale=-2:H` is
 *          sufficient; `-2` already preserves aspect ratio with an even
 *          width.
 *       2. Reusing one audio output (`a:0`) across every variant in
 *          `-var_stream_map`. Audio must be mapped PER VARIANT
 *          (`-map 0:a:0?` once per rung, `-c:a aac` applied globally) with a
 *          distinct `a:i` per variant in `-var_stream_map`.
 */

import { join } from "node:path";

export interface LadderRung {
  height: number;
  bitrateK: number;
}

/** Default ABR ladder, highest rung first. Filtered at build time (see
 * `computeRungs`) to the source's native height (never upscale) and the
 * caller's requested ceiling (TRANSCODE_MAX_HEIGHT=1080 from the app side). */
export const LADDER: LadderRung[] = [
  { height: 2160, bitrateK: 16000 },
  { height: 1080, bitrateK: 5000 },
  { height: 720, bitrateK: 2800 },
  { height: 480, bitrateK: 1400 },
];

/** Per-segment duration default (seconds) — short segments = fast startup +
 * the ability to serve a still-transcoding ladder incrementally. */
export const DEFAULT_SEGMENT_DURATION_S = 4;
/** VBV headroom over the target bitrate — standard ABR-ladder practice. */
const MAXRATE_FACTOR = 1.07;
/** VBV buffer size relative to target bitrate — conservative, widely used. */
const BUFSIZE_FACTOR = 2;
/**
 * Assumed fps for GOP-length math. We don't probe real fps (a second ffprobe
 * round trip for a value that only affects keyframe cadence, not
 * correctness) — 30 is a safe upper bound for typical sources; worst case we
 * key-frame slightly more often than strictly required for a >30fps source,
 * which costs a little bitrate but never breaks segmentation.
 */
const ASSUMED_FPS = 30;

export function rungLabel(height: number): string {
  return height >= 2160 ? "4k" : `${height}p`;
}

/**
 * REMUX: rewrap an MKV/WebM into fMP4 HLS without touching the bitstream.
 *
 * This is a fundamentally different operation from everything else in this file
 * and must not be confused with it. Transcoding DECODES and RE-ENCODES, which is
 * why the worker is production-disabled (a cold 4K HEVC job measured 17.4 GiB
 * and 1378% CPU). A remux copies the encoded streams byte-for-byte and only
 * rewrites the container, so it costs essentially nothing: measured on this box,
 * 60s of 3840x2160 10-bit AV1 remuxed in 6s wall — roughly 10x realtime, I/O
 * bound on the download rather than the CPU.
 *
 * Why it is worth having: MKV plays in NO browser, not even Safari, so every
 * MKV release is currently unusable regardless of what is inside it. But a large
 * share of them hold codecs the browser CAN decode — notably AV1 (Chrome and
 * Firefox decode it natively) and H.264. Interstellar's cached 4K, for example,
 * is `AV1 Main 3840x2160 yuv420p10le` with Opus audio in an MKV: both streams
 * are natively decodable by Chrome, and only the container blocks playback.
 * Rewrapping it delivers genuine 4K with no encoding at all.
 *
 * fMP4 segments (`-hls_segment_type fmp4`) are required, not a preference:
 * MPEG-TS cannot carry AV1 or HEVC. That also means an `#EXT-X-MAP` init
 * segment and `#EXT-X-VERSION:7`, both of which hls.js handles natively.
 *
 * Audio is copied too. Opus/AAC/FLAC ride along fine in fMP4; a source whose
 * audio the browser cannot decode is a failover case, exactly as it is today,
 * and is not worth an encode pass on the shared host.
 */
/** Sustained read speed for a remux, as a multiple of realtime. */
const REMUX_READ_RATE = 4;
/** AAC bitrate for the remux's stereo downmix. */
const REMUX_AUDIO_BITRATE_K = 192;
/** Seconds of input read at full speed before the throttle applies. */
const REMUX_INITIAL_BURST_S = 60;

export function buildRemuxArgs(input: {
  inputUrl: string;
  outDir: string;
  segmentDurationS?: number;
}): string[] {
  const seg = input.segmentDurationS ?? DEFAULT_SEGMENT_DURATION_S;
  return [
    "-hide_banner",
    "-loglevel", "error",
    // Keep the reconnect behaviour the transcode path relies on: these are long
    // reads from a remote CDN and a dropped socket must not kill the job.
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    /**
     * Throttle the read, but only after a head start.
     *
     * An unthrottled stream copy runs at whatever the link allows - measured
     * around 10x realtime - so it races far ahead of the viewer, pulls ~10x the
     * title's bitrate from the debrid CDN for the whole film, and writes the
     * entire file to disk within minutes whether or not anyone is still
     * watching. Two concurrent 4K jobs saturated the connection outright and
     * pushed a cold start past the player's manifest timeout, which is how a
     * 4K source ended up failing over to a 1080p embed.
     *
     * The burst keeps startup instant (the first segments are still read at
     * full speed), then REMUX_READ_RATE holds a steady lead over playback -
     * enough to absorb a seek or a slow patch, without running away.
     */
    "-readrate_initial_burst", String(REMUX_INITIAL_BURST_S),
    "-readrate", String(REMUX_READ_RATE),
    "-i", input.inputUrl,
    // The whole point: copy, never encode — the VIDEO, which is where all the
    // cost and all the resolution is.
    "-c:v", "copy",
    /**
     * Audio is the exception, and it has to be.
     *
     * MKV releases routinely carry DTS-HD MA, TrueHD, E-AC3, FLAC or PCM, none
     * of which any browser can decode. Copying them produces a file whose video
     * is perfect and whose audio track MSE rejects outright — which fails the
     * whole append, so the player retries the same fragment and eventually
     * drops to a lower-quality source. Measured on Interstellar: a 3840-wide
     * H.264 remux served DTS-HD MA and cost ~28s of retries before falling back
     * to 1080p.
     *
     * Re-encoding audio is nothing like re-encoding video: it is a few percent
     * of one core against a stream that is ~1% of the bitrate, so the remux
     * stays I/O bound and 4K survives untouched. Doing it unconditionally also
     * keeps an ffprobe round trip off the startup path — the alternative was
     * detecting the codec first, which costs more time than the encode does.
     *
     * Stereo downmix: multichannel AAC decode is inconsistent across browsers,
     * and a downmix that always plays beats a surround track that sometimes
     * does not.
     */
    "-c:a", "aac",
    "-b:a", String(REMUX_AUDIO_BITRATE_K) + "k",
    "-ac", "2",
    // First audio + first video only. Multi-track MKVs are common and a stray
    // subtitle/attachment stream will otherwise fail the mux into fMP4.
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-f", "hls",
    "-hls_time", String(seg),
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", join(input.outDir, "seg_%05d.m4s"),
    join(input.outDir, "master.m3u8"),
  ];
}

/**
 * Ladder rungs for a source, filtered to min(sourceHeight, maxHeight) so we
 * never upscale and never exceed the caller's requested ceiling. Highest
 * rung first (matches LADDER's order). Falls back to a single synthetic rung
 * at the cap when nothing in LADDER qualifies (e.g. a 360p-only source) — the
 * transcoder always has at least one rung to encode.
 */
export function computeRungs(sourceHeight: number, maxHeight: number): LadderRung[] {
  const cap = sourceHeight > 0 ? Math.min(sourceHeight, maxHeight) : maxHeight;
  const rungs = LADDER.filter((r) => r.height <= cap);
  if (rungs.length === 0) {
    const fallbackHeight = cap > 0 ? cap : maxHeight;
    rungs.push({ height: fallbackHeight, bitrateK: estimateBitrateK(fallbackHeight) });
  }
  return rungs;
}

/**
 * Bitrate estimate (kbps) for a height not on LADDER (e.g. a 360p-only
 * source, or an odd probed height). Interpolates between LADDER's known
 * height→bitrate points; extrapolates below the lowest rung using its
 * kbps-per-row ratio, and clamps above the highest rung to its bitrate
 * (never invents a bigger number than the ladder's own top rung).
 */
export function estimateBitrateK(height: number): number {
  const sorted = [...LADDER].sort((a, b) => a.height - b.height);
  if (height <= 0) return sorted[0]!.bitrateK;
  const exact = LADDER.find((r) => r.height === height);
  if (exact) return exact.bitrateK;
  if (height < sorted[0]!.height) {
    const ratio = sorted[0]!.bitrateK / sorted[0]!.height;
    return Math.max(300, Math.round(height * ratio));
  }
  if (height > sorted[sorted.length - 1]!.height) {
    return sorted[sorted.length - 1]!.bitrateK;
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (height >= lo.height && height <= hi.height) {
      const t = (height - lo.height) / (hi.height - lo.height);
      return Math.round(lo.bitrateK + t * (hi.bitrateK - lo.bitrateK));
    }
  }
  return sorted[sorted.length - 1]!.bitrateK;
}

/**
 * The filter fragment applied ONCE, immediately after decode, before the
 * ladder split (or before the single `-vf` chain in the single-rung shape).
 * VAAPI decode produces hardware surfaces — `hwdownload` back to a software
 * frame (nv12) is mandatory before any software filter (scale/libx264) can
 * touch it. Returns "" for software decode — callers skip prepending a
 * comma/filter stage entirely in that case.
 *
 * Deliberately NOT HDR-aware (no tonemap chain here — see the module
 * docstring). Every source, HDR or SDR, gets the same `format=yuv420p` at
 * the end of its per-rung scale filter.
 */
export function buildDecodePrefixFilter(useVaapi: boolean): string {
  return useVaapi ? "hwdownload,format=nv12" : "";
}

export interface BuildFfmpegArgsInput {
  inputUrl: string;
  outDir: string;
  rungs: LadderRung[];
  useVaapi: boolean;
  vaapiDevice: string;
  hasAudio: boolean;
  segmentDurationS?: number;
}

export interface FfmpegPlan {
  args: string[];
  /** True for the simple single-output shape: a flat master.m3u8 with
   * segments directly in outDir (no separate variant playlist). Used for the
   * ≤480p-only case and as the guaranteed-simplest retry target when the
   * full ladder build fails. */
  singleRung: boolean;
  /** Variant playlist filenames referenced by the master (e.g.
   * ["v0.m3u8","v1.m3u8"]) — empty for the single-rung shape, where segments
   * are referenced directly from master.m3u8 instead. */
  variantPlaylists: string[];
}

/**
 * Build the full ffmpeg argv for a transcode job.
 *
 *  - rungs.length === 1 → the simple single-output HLS shape: one `-vf`
 *    chain, one `-c:v`, a flat master.m3u8 with inline segment references.
 *    This is both the ≤480p-only path and the guaranteed-simplest fallback
 *    shape when the full ladder build fails at runtime.
 *  - rungs.length > 1 → a real multi-rung ABR ladder in ONE ffmpeg run:
 *    `-filter_complex` splits the (hwdownloaded, if VAAPI) decoded frame
 *    into N legs, each scaled to its rung height and encoded with libx264 at
 *    that rung's bitrate; `-var_stream_map` + `-master_pl_name` produce a
 *    master.m3u8 with one `#EXT-X-STREAM-INF` per rung (RESOLUTION +
 *    BANDWIDTH included) referencing flat `vN.m3u8` variant playlists, whose
 *    segments are also flat filenames (`seg_N_%05d.ts`) — no subdirectories
 *    anywhere, so the existing `/^[\w.-]+$/` path-safety regexes (transcoder
 *    + Next.js route) need no changes.
 *
 * Audio is mapped PER VARIANT (`-map 0:a:0?` once per rung, each becoming
 * its own output audio stream) with a distinct `a:i` per variant in
 * `-var_stream_map` — NEVER one shared `a:0` reused across every variant
 * (that breaks the HLS muxer's per-variant stream pairing). `-c:a`/`-b:a`/
 * `-ac` are given without a stream-specifier suffix so the same AAC settings
 * apply to every mapped audio output; this means audio IS re-encoded once
 * per rung (cheap — AAC encode is negligible next to libx264), not shared.
 */
export function buildFfmpegArgs(input: BuildFfmpegArgsInput): FfmpegPlan {
  const segmentDurationS = input.segmentDurationS ?? DEFAULT_SEGMENT_DURATION_S;
  const gop = String(segmentDurationS * ASSUMED_FPS);
  const args: string[] = ["-hide_banner", "-loglevel", "error"];

  if (input.useVaapi) {
    args.push(
      "-hwaccel", "vaapi",
      "-hwaccel_device", input.vaapiDevice,
      "-hwaccel_output_format", "vaapi"
    );
  }
  args.push("-protocol_whitelist", "https,tls,tcp,http,crypto");
  args.push("-i", input.inputUrl);

  const commonHlsFlags = [
    "-f", "hls",
    "-hls_time", String(segmentDurationS),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments+append_list+omit_endlist",
  ];

  if (input.rungs.length <= 1) {
    const rung = input.rungs[0] ?? { height: 480, bitrateK: estimateBitrateK(480) };
    const prefix = buildDecodePrefixFilter(input.useVaapi);
    const vf = [prefix, `scale=-2:${rung.height}`, "format=yuv420p"]
      .filter(Boolean)
      .join(",");

    args.push("-map", "0:v:0");
    if (input.hasAudio) args.push("-map", "0:a:0?");
    args.push(
      "-vf", vf,
      "-g", gop,
      "-keyint_min", gop,
      "-sc_threshold", "0",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-b:v", `${rung.bitrateK}k`,
      "-maxrate", `${Math.round(rung.bitrateK * MAXRATE_FACTOR)}k`,
      "-bufsize", `${Math.round(rung.bitrateK * BUFSIZE_FACTOR)}k`
    );
    if (input.hasAudio) {
      args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
    }
    args.push(
      ...commonHlsFlags,
      "-hls_segment_filename", join(input.outDir, "seg_%05d.ts"),
      join(input.outDir, "master.m3u8")
    );
    return { args, singleRung: true, variantPlaylists: [] };
  }

  const n = input.rungs.length;
  const prefix = buildDecodePrefixFilter(input.useVaapi);
  const splitLabels = input.rungs.map((_, i) => `[s${i}]`).join("");
  const head = prefix
    ? `[0:v:0]${prefix},split=${n}${splitLabels}`
    : `[0:v:0]split=${n}${splitLabels}`;
  const legs = input.rungs.map(
    (r, i) => `[s${i}]scale=-2:${r.height},format=yuv420p[v${i}out]`
  );
  args.push("-filter_complex", [head, ...legs].join(";"));

  input.rungs.forEach((r, i) => {
    args.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264",
      `-preset:v:${i}`, "veryfast",
      `-b:v:${i}`, `${r.bitrateK}k`,
      `-maxrate:v:${i}`, `${Math.round(r.bitrateK * MAXRATE_FACTOR)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.bitrateK * BUFSIZE_FACTOR)}k`,
      `-g:v:${i}`, gop,
      `-keyint_min:v:${i}`, gop,
      `-sc_threshold:v:${i}`, "0"
    );
  });
  if (input.hasAudio) {
    // One -map per rung -> one distinct output audio stream per rung, so
    // var_stream_map's "a:i" always refers to a real, rung-specific stream.
    input.rungs.forEach(() => args.push("-map", "0:a:0?"));
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  }

  const varStreamMap = input.rungs
    .map((_, i) => (input.hasAudio ? `v:${i},a:${i}` : `v:${i}`))
    .join(" ");
  args.push(
    ...commonHlsFlags,
    "-var_stream_map", varStreamMap,
    "-master_pl_name", "master.m3u8",
    "-hls_segment_filename", join(input.outDir, "seg_%v_%05d.ts"),
    join(input.outDir, "v%v.m3u8")
  );

  const variantPlaylists = input.rungs.map((_, i) => `v${i}.m3u8`);
  return { args, singleRung: false, variantPlaylists };
}

/**
 * Filenames of `.m3u8` lines referenced by a master playlist (i.e. the
 * variant sub-playlists a multi-rung ladder's master.m3u8 points at). Empty
 * for a single-rung/flat master, whose non-comment lines are `.ts` segments,
 * not sub-playlists. Used by the caller to bound how long it waits for the
 * FIRST variant playlist to actually exist on disk before handing the master
 * back to a client (ffmpeg writes master.m3u8 as soon as the output streams
 * are known, which can be before any variant playlist has segments yet).
 */
export function extractVariantPlaylistNames(masterPlaylist: string): string[] {
  return masterPlaylist
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.endsWith(".m3u8"));
}
