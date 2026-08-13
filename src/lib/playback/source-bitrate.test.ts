import { describe, expect, it } from "bun:test";
import {
  compareBitrateAtEqualHeight,
  isMeaningfullyRicherSource,
  normalizedBitrate,
  pickDefaultSource,
  sortSourcesForPicker,
} from "./source-quality";
import type { PlaybackSource } from "./types";

function source(over: Partial<PlaybackSource> & { id: string }): PlaybackSource {
  return {
    url: `https://cdn.example/${over.id}/index.m3u8`,
    provider: "testprov",
    quality: "1080p",
    label: "HLS",
    type: "hls",
    maxHeight: 1080,
    ...over,
  } as PlaybackSource;
}

describe("normalizedBitrate", () => {
  it("returns 0 when the manifest declared nothing", () => {
    expect(normalizedBitrate(source({ id: "a" }))).toBe(0);
  });

  it("credits modern codecs for matching quality on fewer bits", () => {
    const h264 = source({ id: "a", bitrateBps: 8_000_000, codec: "h264" });
    const hevc = source({ id: "b", bitrateBps: 6_000_000, codec: "hevc" });
    // 6 Mbps HEVC (x1.6 = 9.6M) is the better encode despite the smaller number.
    expect(normalizedBitrate(hevc)).toBeGreaterThan(normalizedBitrate(h264));
  });

  it("treats an unknown codec as H.264 rather than inflating it", () => {
    const unknown = source({ id: "a", bitrateBps: 5_000_000 });
    expect(normalizedBitrate(unknown)).toBe(5_000_000);
  });
});

describe("compareBitrateAtEqualHeight", () => {
  it("prefers the richer encode when the gap is meaningful", () => {
    const lean = source({ id: "lean", bitrateBps: 2_000_000 });
    const rich = source({ id: "rich", bitrateBps: 10_000_000 });
    expect(compareBitrateAtEqualHeight(lean, rich)).toBeGreaterThan(0);
    expect(compareBitrateAtEqualHeight(rich, lean)).toBeLessThan(0);
  });

  it("orders close known rates directly so the comparator stays transitive", () => {
    const a = source({ id: "a", bitrateBps: 5_000_000 });
    const b = source({ id: "b", bitrateBps: 5_600_000 });
    expect(compareBitrateAtEqualHeight(a, b)).toBeGreaterThan(0);
  });

  it("ranks measured bitrate ahead of unknown bitrate", () => {
    const silent = source({ id: "silent" });
    const declared = source({ id: "declared", bitrateBps: 9_000_000 });
    expect(compareBitrateAtEqualHeight(silent, declared)).toBeGreaterThan(0);
  });

  it("keeps the cold-switch threshold even though total ordering is exact", () => {
    const current = source({ id: "current", bitrateBps: 5_000_000 });
    const close = source({ id: "close", bitrateBps: 5_600_000 });
    const richer = source({ id: "richer", bitrateBps: 7_000_000 });
    expect(isMeaningfullyRicherSource(current, close)).toBe(false);
    expect(isMeaningfullyRicherSource(current, richer)).toBe(true);
  });

  it("only calls the candidate richer when resolution matches", () => {
    const lean1080 = source({ id: "lean", bitrateBps: 2_000_000 });
    const rich1080 = source({ id: "rich", bitrateBps: 10_000_000 });
    const rich720 = source({
      id: "rich-720",
      maxHeight: 720,
      quality: "720p",
      bitrateBps: 12_000_000,
    });

    expect(isMeaningfullyRicherSource(lean1080, rich1080)).toBe(true);
    expect(isMeaningfullyRicherSource(lean1080, rich720)).toBe(false);
  });

  it("only upgrades an unknown-rate cold source for a strong sustainable rate", () => {
    const unknown = source({ id: "unknown" });
    const ordinary = source({ id: "ordinary", bitrateBps: 4_000_000 });
    const strong = source({ id: "strong", bitrateBps: 8_000_000 });
    const starving = source({
      id: "starving",
      bitrateBps: 12_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 500_000,
        speedScore: 80,
      },
    });

    expect(isMeaningfullyRicherSource(unknown, ordinary)).toBe(false);
    expect(isMeaningfullyRicherSource(unknown, strong)).toBe(true);
    expect(isMeaningfullyRicherSource(unknown, starving)).toBe(false);
  });
});

describe("pickDefaultSource — same height, different encode", () => {
  it("picks the richer 1080p when both sources are otherwise identical", () => {
    const lean = source({ id: "lean-1080", bitrateBps: 2_200_000 });
    const rich = source({ id: "rich-1080", bitrateBps: 11_000_000 });
    expect(pickDefaultSource([lean, rich], null, "auto")?.id).toBe("rich-1080");
    // Order of the input roster must not decide it.
    expect(pickDefaultSource([rich, lean], null, "auto")?.id).toBe("rich-1080");
  });

  it("never lets a fat 1080p outrank a genuine 4K", () => {
    const fatHd = source({ id: "fat-1080", bitrateBps: 25_000_000 });
    const uhd = source({
      id: "true-4k",
      maxHeight: 2160,
      quality: "2160p",
      bitrateBps: 15_000_000,
    });
    expect(pickDefaultSource([fatHd, uhd], null, "auto")?.id).toBe("true-4k");
  });

  it("prefers a rich fixed 1080p over a lean adaptive 1080p", () => {
    const adaptiveLean = source({
      id: "adaptive-lean",
      ladder: [1080, 720, 480],
      bitrateBps: 2_500_000,
    });
    const fixedRich = source({
      id: "fixed-rich",
      ladder: [1080],
      bitrateBps: 10_000_000,
    });

    expect(pickDefaultSource([adaptiveLean, fixedRich], null, 2160)?.id).toBe(
      "fixed-rich"
    );
  });

  it("lets rich 1080p override a saved lean HD server when 4K is unavailable", () => {
    const savedLean = source({
      id: "saved-lean",
      provider: "Vixsrc",
      label: "Eos",
      bitrateBps: 2_000_000,
    });
    const rich = source({
      id: "rich-fallback",
      provider: "Vidking",
      label: "Solstice",
      bitrateBps: 11_000_000,
    });

    expect(
      pickDefaultSource([savedLean, rich], "Vixsrc|Eos", 2160)?.id
    ).toBe("rich-fallback");
  });

  it("keeps the saved HD server when bitrate is tied or unknown", () => {
    const saved = source({
      id: "saved-unknown",
      provider: "Vixsrc",
      label: "Eos",
    });
    const other = source({
      id: "other-unknown",
      provider: "Vidking",
      label: "Solstice",
    });

    expect(pickDefaultSource([other, saved], "Vixsrc|Eos", 2160)?.id).toBe(
      "saved-unknown"
    );
  });

  it("never lets bitrate revive a failed or runtime-unhealthy source", () => {
    const healthyLean = source({
      id: "healthy-lean",
      bitrateBps: 3_000_000,
      verified: true,
    });
    const probeDeadRich = source({
      id: "probe-dead-rich",
      bitrateBps: 15_000_000,
      verified: true,
      probe: { ok: false, ttfbMs: 4_000, bytesPerSec: 0, speedScore: 0 },
    });
    const runtimeDeadRich = source({
      id: "runtime-dead-rich",
      bitrateBps: 18_000_000,
      runtimeHealth: { successRate: 0.1, sampleCount: 10 },
    });

    expect(pickDefaultSource([probeDeadRich, healthyLean], null, 2160)?.id).toBe(
      "healthy-lean"
    );
    expect(
      pickDefaultSource([runtimeDeadRich, healthyLean], null, 2160)?.id
    ).toBe("healthy-lean");
  });

  it("rejects a rich fixed encode the measured link cannot sustain", () => {
    const sustainable = source({
      id: "sustainable",
      bitrateBps: 3_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 1_000_000,
        speedScore: 65,
      },
    });
    const starving = source({
      id: "starving-rich",
      bitrateBps: 10_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 500_000,
        speedScore: 85,
      },
    });

    expect(pickDefaultSource([starving, sustainable], null, 2160)?.id).toBe(
      "sustainable"
    );
  });

  it("keeps an adaptive 4K source when its top rung exceeds probe throughput", () => {
    const adaptive4k = source({
      id: "adaptive-4k",
      maxHeight: 2160,
      quality: "2160p",
      ladder: [2160, 1080, 720],
      bitrateBps: 12_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 1_250_000,
        speedScore: 70,
      },
    });
    const fixed1080 = source({
      id: "fixed-1080",
      bitrateBps: 5_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 1_250_000,
        speedScore: 70,
      },
    });

    expect(pickDefaultSource([fixed1080, adaptive4k], null, 2160)?.id).toBe(
      "adaptive-4k"
    );
  });

  it("honours an explicit 1080 target while Ultra still chooses 4K", () => {
    const hd = source({ id: "hd", bitrateBps: 8_000_000 });
    const uhd = source({
      id: "uhd",
      maxHeight: 2160,
      quality: "2160p",
      bitrateBps: 14_000_000,
    });
    expect(pickDefaultSource([uhd, hd], null, 1080)?.id).toBe("hd");
    expect(pickDefaultSource([uhd, hd], null, 2160)?.id).toBe("uhd");
  });

  it("is permutation-stable when 4K adaptive also offers explicit 1080", () => {
    const adaptive4k = source({
      id: "adaptive-4k",
      maxHeight: 2160,
      quality: "2160p",
      ladder: [2160, 1080, 720],
    });
    const adaptiveLean = source({
      id: "adaptive-lean",
      ladder: [1080, 720],
      bitrateBps: 2_000_000,
    });
    const fixedRich = source({
      id: "fixed-rich",
      ladder: [1080],
      bitrateBps: 12_000_000,
    });
    const permutations = [
      [adaptive4k, adaptiveLean, fixedRich],
      [adaptive4k, fixedRich, adaptiveLean],
      [adaptiveLean, adaptive4k, fixedRich],
      [adaptiveLean, fixedRich, adaptive4k],
      [fixedRich, adaptive4k, adaptiveLean],
      [fixedRich, adaptiveLean, adaptive4k],
    ];

    for (const roster of permutations) {
      expect(pickDefaultSource(roster, null, 1080)?.id).toBe("fixed-rich");
    }
  });

  it("does not treat a 4K ladder's top bitrate as its explicit 1080 rate", () => {
    const adaptive4k = source({
      id: "adaptive-4k",
      maxHeight: 2160,
      quality: "2160p",
      ladder: [2160, 1080, 720],
      bitrateBps: 24_000_000,
    });
    const fixedRich = source({
      id: "fixed-rich",
      bitrateBps: 12_000_000,
    });

    expect(pickDefaultSource([adaptive4k, fixedRich], null, 1080)?.id).toBe(
      "fixed-rich"
    );
  });

  it("requires comparable health for Auto but lets an explicit Ultra target probe 4K", () => {
    const healthyHd = source({
      id: "healthy-hd",
      bitrateBps: 6_000_000,
      probe: {
        ok: true,
        ttfbMs: 100,
        bytesPerSec: 2_000_000,
        speedScore: 80,
      },
    });
    const unproven4k = source({
      id: "unproven-4k",
      maxHeight: 2160,
      quality: "2160p",
      bitrateBps: 14_000_000,
    });
    expect(pickDefaultSource([unproven4k, healthyHd], null, "auto")?.id).toBe(
      "healthy-hd"
    );
    expect(pickDefaultSource([unproven4k, healthyHd], null, 2160)?.id).toBe(
      "unproven-4k"
    );
  });

  it("is permutation-stable with known and unknown equal-height rates", () => {
    const lean = source({
      id: "lean",
      bitrateBps: 4_000_000,
      ladder: [1080, 720],
    });
    const unknown = source({ id: "unknown", ladder: [1080, 720] });
    const rich = source({ id: "rich", bitrateBps: 6_000_000 });
    const permutations = [
      [lean, unknown, rich],
      [lean, rich, unknown],
      [unknown, lean, rich],
      [unknown, rich, lean],
      [rich, lean, unknown],
      [rich, unknown, lean],
    ];

    for (const roster of permutations) {
      expect(pickDefaultSource(roster, null, "auto")?.id).toBe("rich");
      expect(sortSourcesForPicker(roster).map((entry) => entry.id)).toEqual([
        "rich",
        "lean",
        "unknown",
      ]);
    }
  });

  it("leaves rosters without bitrate data ordered exactly as before", () => {
    const a = source({ id: "a-plain" });
    const b = source({ id: "b-plain" });
    const before = pickDefaultSource([a, b], null, "auto")?.id;
    expect(before).toBe("a-plain");
  });
});
