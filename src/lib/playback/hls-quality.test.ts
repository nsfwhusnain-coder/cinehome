/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  adaptiveRecoveryPhase,
  annotateLevelHeights,
  buildQualityOptions,
  deriveHeightFromBitrate,
  findBestLevelForTarget,
  findFloorBitrateKbps,
  findLowerLevelIndexForHeight,
  findMinLevelIndexForHeight,
  hlsPromotionTargetHeight,
  isQualityMismatch,
  pickDefaultQualityIndex,
  pickHighestLevelIndex,
  pickStartLevelIndex,
  levelsFromQualityRungs,
} from "./hls-quality";
import type { QualityLevel } from "@/stores/player-store";

/**
 * Quality menu must list every distinct height on the active source so the
 * user can switch freely (4K / 1080 / 720 / 480). Default start is still
 * pickDefaultQualityIndex (≥1080 when present).
 */
describe("levelsFromQualityRungs", () => {
  it("turns an MP4 host ladder into picker levels", () => {
    const levels = levelsFromQualityRungs([
      { height: 1080, bitrateBps: 4_000_000 },
      { height: 720 },
      { height: 480 },
    ]);
    expect(levels.map((level) => level.height)).toEqual([1080, 720, 480]);
    expect(levels[0]?.index).toBe(0);
    expect(levels[0]?.bitrate).toBe(4_000_000);
  });
});

describe("buildQualityOptions", () => {
  it("classifies cropped 1920-wide cinema levels as 1080p", () => {
    expect(
      buildQualityOptions([{ index: 0, width: 1920, height: 800, bitrate: 4_000_000 }])
    ).toEqual([
      { index: 0, height: 1080, label: "1080p" },
    ]);
  });
  it("HD ladder [1080,720,480] -> shows all rungs (not HD-only)", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
      { index: 2, height: 1080 },
    ];
    const options = buildQualityOptions(levels);
    expect(options.map((o) => o.label)).toEqual(["1080p", "720p", "480p"]);
    expect(options[0]!.isMaxAvailable).toBeUndefined();
  });

  it("sub-HD ladder [720,480] -> shows both rungs, top flagged max available", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
    ];
    const options = buildQualityOptions(levels);
    expect(options.length).toBe(2);
    expect(options.map((o) => o.label)).toEqual(["720p", "480p"]);
    expect(options[0]!.isMaxAvailable).toBe(true);
    expect(options[1]!.isMaxAvailable).toBeUndefined();
  });

  it("single fixed level [1080] -> shows 1080p", () => {
    const levels: QualityLevel[] = [{ index: 0, height: 1080 }];
    const options = buildQualityOptions(levels);
    expect(options.length).toBe(1);
    expect(options[0]!.label).toBe("1080p");
  });

  it("empty ladder -> empty options (Auto is rendered separately by the dock)", () => {
    expect(buildQualityOptions([])).toEqual([]);
  });

  it("bitrate-only ladder (no RESOLUTION) -> derives heights and surfaces all rungs", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 0, bitrate: 900_000 }, // -> 480
      { index: 1, height: 0, bitrate: 1_500_000 }, // -> 720
      { index: 2, height: 0, bitrate: 4_000_000 }, // -> 1080
    ];
    const options = buildQualityOptions(levels);
    expect(options.map((o) => o.label)).toEqual(["1080p", "720p", "480p"]);
  });

  it("bitrate-only ladder that never reaches 1080 -> surfaces real derived rungs", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 0, bitrate: 750_000 }, // -> 480
      { index: 1, height: 0, bitrate: 1_300_000 }, // -> 720
    ];
    const options = buildQualityOptions(levels);
    expect(options.length).toBe(2);
    expect(options.map((o) => o.label)).toEqual(["720p", "480p"]);
    expect(options[0]!.isMaxAvailable).toBe(true);
  });

  it("dedupes repeated heights across levels", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080 },
      { index: 1, height: 1080 },
      { index: 2, height: 2160 },
    ];
    const options = buildQualityOptions(levels);
    expect(options.map((o) => o.label)).toEqual(["4K", "1080p"]);
  });

  it("retains the highest-bitrate representation when heights repeat", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 3_000_000 },
      { index: 1, height: 2160, bitrate: 12_000_000 },
      { index: 2, height: 1080, bitrate: 8_000_000 },
    ];
    const options = buildQualityOptions(levels);
    expect(options).toEqual([
      { index: 1, height: 2160, label: "4K" },
      { index: 2, height: 1080, label: "1080p" },
    ]);
  });

  it("includes 4K + full ladder", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
      { index: 2, height: 1080 },
      { index: 3, height: 2160 },
    ];
    expect(buildQualityOptions(levels).map((o) => o.label)).toEqual([
      "4K",
      "1080p",
      "720p",
      "480p",
    ]);
  });
});

describe("annotateLevelHeights", () => {
  it("fills missing heights from scraper ladder by bitrate rank", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 0, bitrate: 800_000 },
      { index: 1, height: 0, bitrate: 2_000_000 },
      { index: 2, height: 0, bitrate: 5_000_000 },
    ];
    const out = annotateLevelHeights(levels, [1080, 720, 480], 1080);
    expect(out.map((l) => l.height).sort((a, b) => a - b)).toEqual([480, 720, 1080]);
  });

  it("keeps an 8 Mbps no-height top rung at exact source-ladder 4K", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 0, bitrate: 4_000_000 },
      { index: 1, height: 0, bitrate: 8_000_000 },
    ];
    const out = annotateLevelHeights(levels, [2160, 1080], 2160);
    expect(out.map((level) => level.height)).toEqual([1080, 2160]);
    const single = annotateLevelHeights(
      [{ index: 0, height: 0, bitrate: 8_000_000 }],
      [2160, 1080],
      2160
    );
    expect(single[0]?.height).toBe(2160);
  });

  it("single level uses source maxHeight", () => {
    const out = annotateLevelHeights([{ index: 0, height: 0, bitrate: 0 }], [], 1080);
    expect(out[0]!.height).toBe(1080);
  });
});

describe("pickDefaultQualityIndex", () => {
  it("defaults to the LOWEST >=1080 rung, never jumping straight to 1440/4K", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 1080 },
      { index: 2, height: 2160 },
    ];
    expect(pickDefaultQualityIndex(levels)).toBe(1);
  });

  it("[2160,1080,720,480] ladder -> defaults to 1080", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
      { index: 2, height: 1080 },
      { index: 3, height: 2160 },
    ];
    expect(pickDefaultQualityIndex(levels)).toBe(2);
  });

  it("defaults to the highest-bitrate representation on the 1080 floor", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 3_000_000 },
      { index: 1, height: 2160, bitrate: 14_000_000 },
      { index: 2, height: 1080, bitrate: 9_000_000 },
    ];
    expect(pickDefaultQualityIndex(levels)).toBe(2);
  });

  it("single [1080] level -> defaults to it", () => {
    expect(pickDefaultQualityIndex([{ index: 0, height: 1080 }])).toBe(0);
  });

  it("flags a sub-HD-only ladder instead of silently defaulting to the highest available rung", () => {
    expect(
      pickDefaultQualityIndex([
        { index: 0, height: 480 },
        { index: 1, height: 720 },
      ])
    ).toBe(-1);
  });

  it("returns -1 for an empty ladder", () => {
    expect(pickDefaultQualityIndex([])).toBe(-1);
  });
});

describe("ABR floor guard (findMinLevelIndexForHeight / findBestLevelForTarget)", () => {
  it("findMinLevelIndexForHeight picks the lowest >=1080 rung, never below", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
      { index: 2, height: 1080 },
      { index: 3, height: 2160 },
    ];
    expect(findMinLevelIndexForHeight(levels, 1080)).toBe(2);
  });

  it("findMinLevelIndexForHeight falls back to the highest available rung when nothing meets the floor", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
    ];
    expect(findMinLevelIndexForHeight(levels, 1080)).toBe(1);
  });

  it("findMinLevelIndexForHeight picks the highest bitrate at the floor height", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 3_000_000 },
      { index: 1, height: 2160, bitrate: 12_000_000 },
      { index: 2, height: 1080, bitrate: 8_000_000 },
    ];
    expect(findMinLevelIndexForHeight(levels, 1080)).toBe(2);
  });

  it("findMinLevelIndexForHeight picks the highest bitrate at the fallback height", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 720, bitrate: 2_000_000 },
      { index: 1, height: 480, bitrate: 4_000_000 },
      { index: 2, height: 720, bitrate: 6_000_000 },
    ];
    expect(findMinLevelIndexForHeight(levels, 1080)).toBe(2);
  });

  it("findBestLevelForTarget prefers the lowest rung >= target (1080), not 1440/4K", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 720 },
      { index: 1, height: 1080 },
      { index: 2, height: 2160 },
    ];
    expect(findBestLevelForTarget(levels, 1080)).toBe(1);
  });

  it("findBestLevelForTarget never resolves below the target when a >=target rung exists", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 1080 },
    ];
    expect(findBestLevelForTarget(levels, 1080)).toBe(1);
  });

  it("findBestLevelForTarget picks the highest bitrate at the closest qualifying height", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 3_000_000 },
      { index: 1, height: 2160, bitrate: 15_000_000 },
      { index: 2, height: 1080, bitrate: 8_000_000 },
    ];
    expect(findBestLevelForTarget(levels, 1080)).toBe(2);
  });

  it("findBestLevelForTarget keeps 4K above a higher-bitrate 1080 representation", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 20_000_000 },
      { index: 1, height: 2160, bitrate: 12_000_000 },
    ];
    expect(findBestLevelForTarget(levels, 2160)).toBe(1);
  });

  it("uses the richest duplicate 1080 rendition for the DASH Auto floor", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 2_500_000 },
      { index: 1, height: 2160, bitrate: 14_000_000 },
      { index: 2, height: 1080, bitrate: 9_000_000 },
    ];
    expect(findFloorBitrateKbps(levels, 1080)).toBe(9_000);
  });

  it("adaptive downshift chooses a real lower rung on sparse ladders", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 720 },
      { index: 1, height: 1080 },
      { index: 2, height: 2160 },
    ];
    expect(findLowerLevelIndexForHeight(levels, 2160, 1296, 480)).toBe(1);
  });

  it("adaptive downshift falls to 480 when 1080 has no 720 rung", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 1080 },
    ];
    expect(findLowerLevelIndexForHeight(levels, 1080, 648, 480)).toBe(0);
  });

  it("adaptive downshift never returns the current rung or crosses its floor", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 360 },
      { index: 1, height: 1080 },
    ];
    expect(findLowerLevelIndexForHeight(levels, 1080, 648, 480)).toBe(-1);
  });

  it("holds a downshift until adaptive buffer recovery is sustained", () => {
    expect(adaptiveRecoveryPhase("adaptive", 1, 12)).toBe("hold");
    expect(adaptiveRecoveryPhase("adaptive", 11.9, 12)).toBe("hold");
    expect(adaptiveRecoveryPhase("adaptive", 12, 12)).toBe("climb");
    expect(adaptiveRecoveryPhase("absolute", 0, 12)).toBe("floor");
  });
});

describe("deriveHeightFromBitrate", () => {
  it("classifies common re-encode bitrate bands", () => {
    expect(deriveHeightFromBitrate(8_000_000)).toBe(1080);
    expect(deriveHeightFromBitrate(4_000_000)).toBe(1080);
    expect(deriveHeightFromBitrate(1_500_000)).toBe(720);
    expect(deriveHeightFromBitrate(800_000)).toBe(480);
  });
});

describe("pickHighestLevelIndex", () => {
  it("locks Ultra onto the richest 4K rung", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 8_000_000 },
      { index: 1, height: 2160, bitrate: 12_000_000 },
      { index: 2, height: 2160, bitrate: 22_000_000 },
    ];
    expect(pickHighestLevelIndex(levels)).toBe(2);
    expect(pickStartLevelIndex(levels, 2160)).toBe(2);
  });
});

describe("isQualityMismatch", () => {
  it("never flags Auto (quality index -1)", () => {
    expect(isQualityMismatch(1080, 720, -1)).toBe(false);
  });

  it("flags when actual is well below selected fixed height", () => {
    expect(isQualityMismatch(1080, 720, 2)).toBe(true);
  });

  it("does not flag when actual meets selected (or is unknown)", () => {
    expect(isQualityMismatch(1080, 1080, 2)).toBe(false);
    expect(isQualityMismatch(1080, 0, 2)).toBe(false);
  });
});

describe("hlsPromotionTargetHeight", () => {
  const subHd: QualityLevel[] = [
    { index: 0, height: 480 },
    { index: 1, height: 720 },
  ];
  const hd: QualityLevel[] = [
    { index: 0, height: 480 },
    { index: 1, height: 1080 },
    { index: 2, height: 2160 },
  ];

  it("leaves a sub-HD Auto ladder to ABR instead of forcing its highest rung", () => {
    expect(hlsPromotionTargetHeight(subHd, "auto")).toBeNull();
  });

  it("honors an exact fixed 480p pick on a 720p-max ladder", () => {
    expect(hlsPromotionTargetHeight(subHd, 480)).toBe(480);
  });

  it("bounds a fixed preference by the real ladder ceiling", () => {
    expect(hlsPromotionTargetHeight(subHd, 1080)).toBe(720);
  });

  it("keeps Auto at the product floor when an HD ladder has that floor", () => {
    expect(hlsPromotionTargetHeight(hd, "auto")).toBe(1080);
  });

  it("restores the exact fixed 4K preference rather than stopping at 1080p", () => {
    expect(hlsPromotionTargetHeight(hd, 2160)).toBe(2160);
  });
});

describe("findBestLevelForTarget fixed-pick honesty", () => {
  it("fixed 1080 on a 720-max ladder falls back to 720 (never invents 1080)", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
    ];
    expect(findBestLevelForTarget(levels, 1080)).toBe(1);
  });

  it("fixed 1080 on a ladder with 1080+ picks real 1080 not 4K", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080 },
      { index: 1, height: 2160 },
    ];
    expect(findBestLevelForTarget(levels, 1080)).toBe(0);
  });

  it("uses the highest-bitrate representation at the fallback height", () => {
    const levels: QualityLevel[] = [
      { index: 0, height: 1080, bitrate: 3_000_000 },
      { index: 1, height: 720, bitrate: 6_000_000 },
      { index: 2, height: 1080, bitrate: 9_000_000 },
    ];
    expect(findBestLevelForTarget(levels, 2160)).toBe(2);
  });
});

/**
 * The first fragment sets the impression. hls.js left to itself opens on
 * whatever the master lists first — usually the lowest rung — so this rule has
 * to answer for every ladder shape, never -1.
 */
describe("pickStartLevelIndex", () => {
  const ladder = [
    { index: 0, height: 480 },
    { index: 1, height: 720 },
    { index: 2, height: 1080 },
    { index: 3, height: 2160 },
  ];

  it("opens at 1080p, not the lowest rung and not 4K", () => {
    // The Squid Game case: the master lists 480p first.
    expect(pickStartLevelIndex(ladder, "auto")).toBe(2);
  });

  it("opens at the best available when nothing reaches the floor", () => {
    // Honest degrade: 720p max means start at 720p, never 480p.
    const subHd = [
      { index: 0, height: 360 },
      { index: 1, height: 720 },
      { index: 2, height: 480 },
    ];
    expect(pickStartLevelIndex(subHd, "auto")).toBe(1);
  });

  it("honours a fixed preference over the auto floor", () => {
    expect(pickStartLevelIndex(ladder, 2160)).toBe(3);
    expect(pickStartLevelIndex(ladder, 720)).toBe(1);
  });

  it("never returns -1 for a ladder that has rungs", () => {
    // -1 hands the choice back to hls.js, which is the bug.
    for (const target of ["auto", 1080, 2160, 480] as const) {
      expect(pickStartLevelIndex(ladder, target)).toBeGreaterThanOrEqual(0);
      expect(pickStartLevelIndex([{ index: 0, height: 0 }], target)).toBe(0);
    }
  });

  it("returns -1 only for an empty ladder", () => {
    expect(pickStartLevelIndex([], "auto")).toBe(-1);
  });
});
