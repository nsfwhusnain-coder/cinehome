import { describe, expect, it } from "bun:test";
import {
  bloomChips,
  bloomMeterProgress,
  bloomPhase,
  bloomPhaseCopy,
  bloomRosterCopy,
  hexToHue,
  MAX_CHIPS,
  premiumSourceCount,
  tmdbPathFromUrl,
  tmdbUrlAtSize,
} from "./bloom-visuals";
import type { PlaybackSource } from "./types";

describe("hexToHue", () => {
  it("reads the hue off a poster tint", () => {
    expect(hexToHue("#ff0000")).toBe(0);
    expect(hexToHue("#00ff00")).toBe(120);
    expect(hexToHue("#0000ff")).toBe(240);
  });

  it("returns null for greys rather than claiming red", () => {
    // A hue of 0 for a grey would tint the whole screen crimson on a lie.
    expect(hexToHue("#808080")).toBeNull();
    expect(hexToHue("#000000")).toBeNull();
    expect(hexToHue("#ffffff")).toBeNull();
  });

  it("returns null for anything that is not a hex colour", () => {
    expect(hexToHue("")).toBeNull();
    expect(hexToHue("rgb(1,2,3)")).toBeNull();
    expect(hexToHue("#abc")).toBeNull();
  });

  it("keeps the hue inside one turn", () => {
    const hue = hexToHue("#ff00ff");
    expect(hue).not.toBeNull();
    expect(hue!).toBeGreaterThanOrEqual(0);
    expect(hue!).toBeLessThan(360);
  });
});

describe("tmdbPathFromUrl", () => {
  it("extracts the path the colour endpoint expects", () => {
    expect(tmdbPathFromUrl("https://image.tmdb.org/t/p/w1280/abc123.jpg")).toBe(
      "/abc123.jpg"
    );
    expect(tmdbPathFromUrl("https://image.tmdb.org/t/p/original/x-Y_9.png")).toBe(
      "/x-Y_9.png"
    );
  });

  it("returns null when there is no image to sample", () => {
    expect(tmdbPathFromUrl(null)).toBeNull();
    expect(tmdbPathFromUrl(undefined)).toBeNull();
    expect(tmdbPathFromUrl("https://example.com/not-tmdb.jpg")).toBeNull();
  });
});

describe("bloomPhase", () => {
  it("stays searching until the player says otherwise", () => {
    expect(bloomPhase(null, 0)).toBe("searching");
    expect(bloomPhase("", 0)).toBe("searching");
  });

  it("advances to connecting on the player's own copy", () => {
    expect(bloomPhase("Connecting… (source 2 of 7)", 7)).toBe("connecting");
    expect(bloomPhase("Preparing 4K…", 3)).toBe("connecting");
    expect(bloomPhase("Repackaging for your browser…", 3)).toBe("connecting");
    expect(bloomPhase("Found 4 sources — choosing the best…", 4)).toBe(
      "connecting"
    );
  });

  it("advances to buffering last", () => {
    expect(bloomPhase("Buffering 1080p…", 5)).toBe("buffering");
    expect(bloomPhase("Buffering…", 5)).toBe("buffering");
  });

  it("does not claim a stage from a count alone", () => {
    // Sources existing is not the same as having chosen one.
    expect(bloomPhase(null, 9)).toBe("searching");
  });
});

describe("bloomMeterProgress", () => {
  it("grows with sources while searching and never invents a full bar", () => {
    expect(bloomMeterProgress("searching", 0, 0)).toBeCloseTo(0.08);
    expect(bloomMeterProgress("searching", 4, 0)).toBeGreaterThan(
      bloomMeterProgress("searching", 1, 0)
    );
    expect(bloomMeterProgress("searching", 40, 1)).toBeLessThanOrEqual(0.28);
  });

  it("steps forward through connecting and opening", () => {
    expect(bloomMeterProgress("connecting", 3, 0)).toBeGreaterThan(
      bloomMeterProgress("searching", 3, 0)
    );
    expect(bloomMeterProgress("buffering", 3, 0.5)).toBeGreaterThan(
      bloomMeterProgress("connecting", 3, 0.5)
    );
    expect(bloomMeterProgress("buffering", 3, 1)).toBe(1);
  });
});

describe("bloomPhaseCopy / bloomRosterCopy", () => {
  it("maps each phase to a short title-card line", () => {
    expect(bloomPhaseCopy("searching")).toBe("Searching");
    expect(bloomPhaseCopy("connecting")).toBe("Preparing");
    expect(bloomPhaseCopy("buffering")).toBe("Opening");
  });

  it("hides the roster until a source exists", () => {
    expect(bloomRosterCopy(0)).toBeNull();
    expect(bloomRosterCopy(1)).toBe("1 source");
    expect(bloomRosterCopy(4)).toBe("4 sources");
  });
});

describe("bloomChips", () => {
  it("shows one chip per source found", () => {
    expect(bloomChips(4, 0, -1)).toHaveLength(4);
    expect(bloomChips(0, 0, -1)).toHaveLength(0);
  });

  it("caps the ring before it stops being countable", () => {
    expect(bloomChips(40, 0, -1)).toHaveLength(MAX_CHIPS);
  });

  it("keeps the premium tier visible even when the roster overflows", () => {
    const chips = bloomChips(40, 2, -1);
    expect(chips.filter((c) => c.premium)).toHaveLength(2);
  });

  it("marks exactly one chosen chip, and only a real one", () => {
    expect(bloomChips(5, 0, 2).filter((c) => c.chosen)).toHaveLength(1);
    expect(bloomChips(5, 0, -1).filter((c) => c.chosen)).toHaveLength(0);
    // Out of range must not silently mark the last chip.
    expect(bloomChips(5, 0, 99).filter((c) => c.chosen)).toHaveLength(0);
  });

  it("never reports more premium chips than there are chips", () => {
    expect(bloomChips(2, 9, -1).filter((c) => c.premium)).toHaveLength(2);
  });

  it("survives nonsense counts without throwing", () => {
    expect(bloomChips(-3, -1, -1)).toHaveLength(0);
    expect(bloomChips(2.7, 0, -1)).toHaveLength(2);
  });
});

describe("premiumSourceCount", () => {
  const src = (over: Partial<PlaybackSource>): PlaybackSource =>
    ({
      id: "s",
      url: "https://x/y.m3u8",
      provider: "p",
      quality: "1080p",
      label: "L",
      type: "hls",
      ...over,
    }) as PlaybackSource;

  it("counts only the debrid 4K tier", () => {
    const roster = [
      src({ origin: "debrid", maxHeight: 2160 }),
      src({ origin: "debrid", maxHeight: 1080 }),
      src({ origin: "embed", maxHeight: 2160 }),
      src({ maxHeight: 2160 }),
    ];
    expect(premiumSourceCount(roster)).toBe(1);
  });

  it("is zero for an empty roster", () => {
    expect(premiumSourceCount([])).toBe(0);
  });
});

describe("tmdbUrlAtSize", () => {
  const BACKDROP = "https://image.tmdb.org/t/p/w1280/abc123_DEF.jpg";

  it("swaps the rendition segment", () => {
    expect(tmdbUrlAtSize(BACKDROP, "w300")).toBe(
      "https://image.tmdb.org/t/p/w300/abc123_DEF.jpg"
    );
  });

  it("replaces the original size whatever it was", () => {
    expect(tmdbUrlAtSize("https://image.tmdb.org/t/p/original/x.jpg", "w300")).toBe(
      "https://image.tmdb.org/t/p/w300/x.jpg"
    );
  });

  it("returns a non-TMDB URL untouched", () => {
    // The loading screen must still show whatever art it was handed; an
    // unrecognised host is not a reason to render nothing.
    const other = "https://example.com/art/backdrop.jpg";
    expect(tmdbUrlAtSize(other, "w300")).toBe(other);
  });

  it("passes through an absent URL", () => {
    expect(tmdbUrlAtSize(null, "w300")).toBeNull();
    expect(tmdbUrlAtSize(undefined, "w300")).toBeNull();
    expect(tmdbUrlAtSize("", "w300")).toBeNull();
  });
});
