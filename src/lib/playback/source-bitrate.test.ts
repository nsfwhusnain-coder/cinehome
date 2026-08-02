import { describe, expect, it } from "bun:test";
import {
  compareBitrateAtEqualHeight,
  normalizedBitrate,
  pickDefaultSource,
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

  it("ignores encoder noise below the 25% margin", () => {
    const a = source({ id: "a", bitrateBps: 5_000_000 });
    const b = source({ id: "b", bitrateBps: 5_600_000 });
    expect(compareBitrateAtEqualHeight(a, b)).toBe(0);
  });

  it("never penalizes a source for declaring no bitrate", () => {
    const silent = source({ id: "silent" });
    const declared = source({ id: "declared", bitrateBps: 9_000_000 });
    expect(compareBitrateAtEqualHeight(silent, declared)).toBe(0);
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

  it("leaves rosters without bitrate data ordered exactly as before", () => {
    const a = source({ id: "a-plain" });
    const b = source({ id: "b-plain" });
    const before = pickDefaultSource([a, b], null, "auto")?.id;
    expect(before).toBe("a-plain");
  });
});
