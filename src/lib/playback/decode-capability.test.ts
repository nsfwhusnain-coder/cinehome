import { describe, expect, it } from "bun:test";
import {
  AV1_PROBE_TYPES,
  HEVC_PROBE_TYPES,
  probeDecodeSync,
} from "./decode-capability";

/** Extract the codec string from a full content-type. */
function codecOf(type: string): string {
  return type.match(/codecs="([^"]+)"/)?.[1] ?? "";
}

/** HEVC codec string → numeric level (the Lxxx field). */
function hevcLevel(codec: string): number {
  return Number(codec.match(/\.L(\d+)/)?.[1] ?? 0);
}

describe("HEVC probe matrix", () => {
  it("covers the 4K levels, which the previous single-string probe did not", () => {
    // The old probe was hvc1.1.6.L93.B0 — Main 8-bit, level 3.1 (~720p).
    // 4K HEVC needs level 5.0 (L150) or 5.1 (L153).
    const levels = HEVC_PROBE_TYPES.map((t) => hevcLevel(codecOf(t)));
    expect(levels.some((l) => l >= 150)).toBe(true);
  });

  it("covers Main10, which is what 4K HDR releases actually use", () => {
    // Profile is the first field: hvc1.<profile>.…  2 = Main10.
    const profiles = HEVC_PROBE_TYPES.map((t) => codecOf(t).split(".")[1]);
    expect(profiles).toContain("2");
  });

  it("still includes the original narrow string so nothing regresses", () => {
    expect(HEVC_PROBE_TYPES).toContain('video/mp4; codecs="hvc1.1.6.L93.B0"');
  });

  it("probes both hvc1 and hev1 box variants", () => {
    const codecs = HEVC_PROBE_TYPES.map(codecOf);
    expect(codecs.some((c) => c.startsWith("hvc1"))).toBe(true);
    expect(codecs.some((c) => c.startsWith("hev1"))).toBe(true);
  });
});

describe("AV1 probe matrix", () => {
  it("covers 10-bit, which the previous 8-bit-only probe did not", () => {
    // av01.<profile>.<level><tier>.<depth> — depth 10 is the 4K HDR case.
    const codecs = AV1_PROBE_TYPES.map(codecOf);
    expect(codecs.some((c) => c.endsWith(".10"))).toBe(true);
  });

  it("still includes the original narrow string", () => {
    expect(AV1_PROBE_TYPES).toContain('video/mp4; codecs="av01.0.05M.08"');
  });
});

describe("probeDecodeSync", () => {
  it("reports unsupported rather than throwing when there is no DOM", () => {
    // Server-side render: no window, no MediaSource, no document.
    const before = globalThis.window;
    // @ts-expect-error deliberately removing the global for this assertion
    delete globalThis.window;
    try {
      expect(probeDecodeSync(HEVC_PROBE_TYPES)).toEqual({ supported: false });
    } finally {
      if (before !== undefined) globalThis.window = before;
    }
  });

  it("treats an empty matrix as unsupported", () => {
    expect(probeDecodeSync([]).supported).toBe(false);
  });
});
