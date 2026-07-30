/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  buildRemuxArgs,
  LADDER,
  buildDecodePrefixFilter,
  buildFfmpegArgs,
  computeRungs,
  estimateBitrateK,
  extractVariantPlaylistNames,
  rungLabel,
} from "./ladder";

describe("computeRungs", () => {
  it("4K source -> full ladder capped at maxHeight=1080 (1080/720/480)", () => {
    const rungs = computeRungs(2160, 1080);
    expect(rungs.map((r) => r.height)).toEqual([1080, 720, 480]);
  });

  it("720p source -> only 720/480 (never upscale above source height)", () => {
    const rungs = computeRungs(720, 1080);
    expect(rungs.map((r) => r.height)).toEqual([720, 480]);
  });

  it("480p source -> single 480 rung", () => {
    const rungs = computeRungs(480, 1080);
    expect(rungs.map((r) => r.height)).toEqual([480]);
  });

  it("360p source (below every ladder rung) -> single synthetic rung at source height", () => {
    const rungs = computeRungs(360, 1080);
    expect(rungs.length).toBe(1);
    expect(rungs[0]!.height).toBe(360);
    expect(rungs[0]!.bitrateK).toBeGreaterThan(0);
  });

  it("unknown source height (0, ffprobe failed) -> falls back to maxHeight-capped full ladder", () => {
    const rungs = computeRungs(0, 1080);
    expect(rungs.map((r) => r.height)).toEqual([1080, 720, 480]);
  });

  it("maxHeight below every rung -> single synthetic rung at maxHeight", () => {
    const rungs = computeRungs(2160, 240);
    expect(rungs.length).toBe(1);
    expect(rungs[0]!.height).toBe(240);
  });

  it("never returns more rungs than LADDER has, and always highest-first", () => {
    const rungs = computeRungs(4000, 4000);
    expect(rungs).toEqual(LADDER);
  });

  it("maxHeight=480 (the guaranteed-fallback ceiling) always yields exactly one rung", () => {
    expect(computeRungs(2160, 480).length).toBe(1);
    expect(computeRungs(480, 480).length).toBe(1);
    expect(computeRungs(240, 480).length).toBe(1);
  });
});

describe("estimateBitrateK", () => {
  it("matches exact ladder points", () => {
    expect(estimateBitrateK(1080)).toBe(5000);
    expect(estimateBitrateK(480)).toBe(1400);
  });

  it("interpolates between bracketing rungs", () => {
    const mid = estimateBitrateK(900); // between 720 (2800) and 1080 (5000)
    expect(mid).toBeGreaterThan(2800);
    expect(mid).toBeLessThan(5000);
  });

  it("extrapolates below the lowest rung using its kbps-per-row ratio", () => {
    const low = estimateBitrateK(360);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(1400);
  });

  it("clamps above the highest rung to the top rung's bitrate", () => {
    expect(estimateBitrateK(4000)).toBe(LADDER[0]!.bitrateK);
  });

  it("height<=0 -> lowest rung's bitrate, never 0 or negative", () => {
    expect(estimateBitrateK(0)).toBeGreaterThan(0);
    expect(estimateBitrateK(-5)).toBeGreaterThan(0);
  });
});

describe("rungLabel", () => {
  it("labels 2160+ as 4k, everything else as <h>p", () => {
    expect(rungLabel(2160)).toBe("4k");
    expect(rungLabel(4320)).toBe("4k");
    expect(rungLabel(1080)).toBe("1080p");
    expect(rungLabel(480)).toBe("480p");
  });
});

describe("buildDecodePrefixFilter", () => {
  it("software decode -> empty (no filter stage needed)", () => {
    expect(buildDecodePrefixFilter(false)).toBe("");
  });

  it("VAAPI decode -> hwdownload to nv12 only (no HDR tonemap chain, ever)", () => {
    expect(buildDecodePrefixFilter(true)).toBe("hwdownload,format=nv12");
  });
});

describe("buildFfmpegArgs — single rung shape (<=480 source or guaranteed fallback)", () => {
  it("one rung -> flat master.m3u8, no var_stream_map/master_pl_name/filter_complex", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs: [{ height: 480, bitrateK: 1400 }],
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    expect(plan.singleRung).toBe(true);
    expect(plan.variantPlaylists).toEqual([]);
    expect(plan.args).not.toContain("-var_stream_map");
    expect(plan.args).not.toContain("-master_pl_name");
    expect(plan.args).not.toContain("-filter_complex");
    expect(plan.args).toContain("-c:v");
    expect(plan.args).toContain("libx264");
    expect(plan.args[plan.args.length - 1]).toBe("/cache/abc123/master.m3u8");
    expect(plan.args).toContain("-c:a");
    expect(plan.args).toContain("aac");
  });

  it("BUG GUARD: scale filter is plain scale=-2:H,format=yuv420p — NEVER force_original_aspect_ratio", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs: [{ height: 480, bitrateK: 1400 }],
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    const vfIdx = plan.args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThanOrEqual(0);
    const vf = plan.args[vfIdx + 1]!;
    expect(vf).toBe("scale=-2:480,format=yuv420p");
    expect(vf).not.toContain("force_original_aspect_ratio");
  });

  it("no audio -> no -c:a / -map 0:a", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs: [{ height: 480, bitrateK: 1400 }],
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: false,
    });
    expect(plan.args).not.toContain("-c:a");
    expect(plan.args.join(" ")).not.toContain("0:a:0");
  });

  it("VAAPI decode requested -> hwaccel decode flags present + vf includes hwdownload,format=nv12", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs: [{ height: 480, bitrateK: 1400 }],
      useVaapi: true,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "-hwaccel", "vaapi",
        "-hwaccel_device", "/dev/dri/renderD128",
        "-hwaccel_output_format", "vaapi",
      ])
    );
    const vfIdx = plan.args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThanOrEqual(0);
    expect(plan.args[vfIdx + 1]).toBe("hwdownload,format=nv12,scale=-2:480,format=yuv420p");
  });

  it("software decode (no VAAPI) -> no hwaccel flags at all", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs: [{ height: 480, bitrateK: 1400 }],
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    expect(plan.args).not.toContain("-hwaccel");
    expect(plan.args).not.toContain("-hwaccel_device");
  });
});

describe("buildFfmpegArgs — multi-rung ABR ladder shape", () => {
  const rungs = [
    { height: 1080, bitrateK: 5000 },
    { height: 720, bitrateK: 2800 },
    { height: 480, bitrateK: 1400 },
  ];

  it("3 rungs -> var_stream_map with 3 entries + master_pl_name + 3 variant playlists", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: true,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    expect(plan.singleRung).toBe(false);
    expect(plan.variantPlaylists).toEqual(["v0.m3u8", "v1.m3u8", "v2.m3u8"]);

    const vsmIdx = plan.args.indexOf("-var_stream_map");
    expect(vsmIdx).toBeGreaterThanOrEqual(0);
    // BUG GUARD: distinct a:i per variant — never one shared a:0 reused
    // across every variant (that's what broke it before).
    expect(plan.args[vsmIdx + 1]).toBe("v:0,a:0 v:1,a:1 v:2,a:2");

    expect(plan.args).toContain("-master_pl_name");
    expect(plan.args[plan.args.indexOf("-master_pl_name") + 1]).toBe("master.m3u8");

    // One libx264 output per rung, addressed by stream specifier.
    expect(plan.args).toContain("-c:v:0");
    expect(plan.args).toContain("-c:v:1");
    expect(plan.args).toContain("-c:v:2");

    expect(plan.args[plan.args.length - 1]).toBe("/cache/abc123/v%v.m3u8");
    expect(plan.args).toContain("-hls_segment_filename");
    expect(plan.args[plan.args.indexOf("-hls_segment_filename") + 1]).toBe(
      "/cache/abc123/seg_%v_%05d.ts"
    );
  });

  it("BUG GUARD: audio mapped PER VARIANT — one -map 0:a:0? per rung, not one shared map", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    const audioMapCount = plan.args.filter(
      (a, i) => a === "-map" && plan.args[i + 1] === "0:a:0?"
    ).length;
    expect(audioMapCount).toBe(3);
    // -c:a/-b:a/-ac given once, unsuffixed, applying to every mapped audio
    // output (so AAC settings are consistent without needing -c:a:i per rung).
    expect(plan.args.filter((a) => a === "-c:a").length).toBe(1);
    expect(plan.args).toContain("aac");
  });

  it("BUG GUARD: every rung's scale is plain scale=-2:H,format=yuv420p — no force_original_aspect_ratio anywhere", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    const fcIdx = plan.args.indexOf("-filter_complex");
    const graph = plan.args[fcIdx + 1]!;
    expect(graph).not.toContain("force_original_aspect_ratio");
    expect(graph).toContain("scale=-2:1080,format=yuv420p");
    expect(graph).toContain("scale=-2:720,format=yuv420p");
    expect(graph).toContain("scale=-2:480,format=yuv420p");
  });

  it("filter_complex splits ONE decoded stream into N legs (decode runs once, not N times)", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: true,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    const fcIdx = plan.args.indexOf("-filter_complex");
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    const graph = plan.args[fcIdx + 1]!;
    // hwdownload appears exactly once, before the split.
    expect(graph.match(/hwdownload/g)?.length).toBe(1);
    expect(graph).toContain("split=3");
    // Three distinct scaled legs, one per rung height.
    expect(graph).toContain("scale=-2:1080");
    expect(graph).toContain("scale=-2:720");
    expect(graph).toContain("scale=-2:480");
  });

  it("no audio -> var_stream_map omits a: component for every rung, no audio map/encode at all", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: false,
    });
    const vsmIdx = plan.args.indexOf("-var_stream_map");
    expect(plan.args[vsmIdx + 1]).toBe("v:0 v:1 v:2");
    expect(plan.args.join(" ")).not.toContain("0:a:0");
    expect(plan.args).not.toContain("-c:a");
  });

  it("each rung gets its own bitrate/maxrate/bufsize (real ABR, not one bitrate for all)", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    expect(plan.args[plan.args.indexOf("-b:v:0") + 1]).toBe("5000k");
    expect(plan.args[plan.args.indexOf("-maxrate:v:0") + 1]).toBe("5350k");
    expect(plan.args[plan.args.indexOf("-bufsize:v:0") + 1]).toBe("10000k");
    expect(plan.args[plan.args.indexOf("-b:v:1") + 1]).toBe("2800k");
    expect(plan.args[plan.args.indexOf("-maxrate:v:1") + 1]).toBe("2996k");
    expect(plan.args[plan.args.indexOf("-bufsize:v:1") + 1]).toBe("5600k");
    expect(plan.args[plan.args.indexOf("-b:v:2") + 1]).toBe("1400k");
    expect(plan.args[plan.args.indexOf("-maxrate:v:2") + 1]).toBe("1498k");
    expect(plan.args[plan.args.indexOf("-bufsize:v:2") + 1]).toBe("2800k");
  });

  it("every rung sets g/keyint_min/sc_threshold (clean HLS segmentation per variant)", () => {
    const plan = buildFfmpegArgs({
      inputUrl: "https://source.example/video.mkv",
      outDir: "/cache/abc123",
      rungs,
      useVaapi: false,
      vaapiDevice: "/dev/dri/renderD128",
      hasAudio: true,
    });
    for (let i = 0; i < 3; i++) {
      expect(plan.args).toContain(`-g:v:${i}`);
      expect(plan.args).toContain(`-keyint_min:v:${i}`);
      expect(plan.args[plan.args.indexOf(`-sc_threshold:v:${i}`) + 1]).toBe("0");
    }
  });
});

describe("extractVariantPlaylistNames", () => {
  it("extracts .m3u8 references from a multi-rung master, ignoring comments", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=5350000,RESOLUTION=1920x1080",
      "v0.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2996000,RESOLUTION=1280x720",
      "v1.m3u8",
    ].join("\n");
    expect(extractVariantPlaylistNames(master)).toEqual(["v0.m3u8", "v1.m3u8"]);
  });

  it("returns empty for a flat single-rung master (segments, not sub-playlists)", () => {
    const master = ["#EXTM3U", "#EXTINF:4.0,", "seg_00000.ts", "#EXTINF:4.0,", "seg_00001.ts"].join(
      "\n"
    );
    expect(extractVariantPlaylistNames(master)).toEqual([]);
  });
});

/**
 * The remux args are the disk-and-bandwidth contract for the whole feature: an
 * unthrottled stream copy runs ~10x realtime, which pulls ~10x the title's
 * bitrate from the CDN and writes the entire film to disk within minutes,
 * whether or not anyone is still watching.
 */
describe("buildRemuxArgs", () => {
  const args = buildRemuxArgs({ inputUrl: "https://cdn.example/movie.mkv", outDir: "/out" });
  const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];

  it("copies the video — that is where all the cost and all the resolution is", () => {
    expect(valueAfter("-c:v")).toBe("copy");
    // No VIDEO encoder settings may appear; their presence would mean the
    // resolution is being re-encoded, which is the thing this path exists to
    // avoid. (Audio is re-encoded on purpose — see the audio block below.)
    expect(args).not.toContain("-crf");
    expect(args).not.toContain("-b:v");
    expect(args).not.toContain("-vf");
    expect(args.some((a) => a.startsWith("libx26"))).toBe(false);
    expect(args.some((a) => a.includes("vaapi"))).toBe(false);
  });

  it("emits fMP4 with an init segment, not MPEG-TS", () => {
    // fMP4 is what makes an MKV's own streams playable without re-encoding;
    // it is also why the playlist rewriter has to handle EXT-X-MAP.
    expect(valueAfter("-hls_segment_type")).toBe("fmp4");
    expect(valueAfter("-hls_fmp4_init_filename")).toBe("init.mp4");
    expect(valueAfter("-hls_segment_filename")).toContain("seg_%05d.m4s");
  });

  it("throttles the read after an initial burst", () => {
    const rate = Number(valueAfter("-readrate"));
    const burst = Number(valueAfter("-readrate_initial_burst"));
    expect(rate).toBeGreaterThan(1); // must stay ahead of playback
    expect(rate).toBeLessThanOrEqual(5); // but not race away from it
    expect(burst).toBeGreaterThan(0); // startup is never throttled
    // The throttle must be applied to the INPUT, so it has to precede -i.
    expect(args.indexOf("-readrate")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-readrate_initial_burst")).toBeLessThan(args.indexOf("-i"));
  });

  it("maps exactly one video and at most one audio stream", () => {
    // Multi-track MKVs are the norm; a stray subtitle or attachment stream
    // fails the mux into fMP4 outright.
    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0?");
  });

  it("keeps the whole playlist so the film stays seekable", () => {
    expect(valueAfter("-hls_list_size")).toBe("0");
    expect(valueAfter("-hls_playlist_type")).toBe("event");
  });
});

/**
 * Audio is the one thing a remux may not copy. MKV releases routinely carry
 * DTS-HD MA / TrueHD / E-AC3 / FLAC / PCM, which no browser decodes; copying
 * them yields perfect video that MSE rejects wholesale, so the player retries
 * the fragment and eventually drops to a worse source.
 */
describe("buildRemuxArgs — audio", () => {
  const args = buildRemuxArgs({ inputUrl: "https://cdn.example/movie.mkv", outDir: "/out" });
  const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];

  it("re-encodes audio to AAC while leaving video copied", () => {
    expect(valueAfter("-c:a")).toBe("aac");
    expect(valueAfter("-c:v")).toBe("copy");
  });

  it("downmixes to stereo, which every browser can decode", () => {
    expect(valueAfter("-ac")).toBe("2");
  });

  it("sets an explicit audio bitrate rather than leaving it to the encoder default", () => {
    expect(valueAfter("-b:a")).toMatch(/^\d+k$/);
  });
});
