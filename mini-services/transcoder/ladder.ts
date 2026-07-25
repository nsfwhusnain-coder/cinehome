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
