/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";

/**
 * `withVerifiedHeight` folds the resolutions an HLS verification already read
 * out of the master playlist into the entry. The rules matter more than the
 * plumbing: it must never overwrite a measured probe, never invent a ladder
 * from a single rendition, and never leave a source labelled "auto" when the
 * master said exactly how tall it is.
 *
 * Re-implemented here rather than exported from the 3000-line scraper module,
 * which starts a Playwright pool and an HTTP server on import.
 */
type Entry = {
  quality: string;
  maxHeight?: number;
  ladder?: number[];
};
type Result = { ok: boolean; maxHeight: number; ladder: number[] };

function withVerifiedHeight(entry: Entry, result: Result): Entry {
  if (!result.maxHeight) return entry;
  if ((entry.maxHeight ?? 0) > 0) return entry;
  return {
    ...entry,
    maxHeight: result.maxHeight,
    ladder: result.ladder.length > 1 ? result.ladder : entry.ladder,
    quality: entry.quality === "auto" ? `${result.maxHeight}p` : entry.quality,
  };
}

describe("withVerifiedHeight", () => {
  it("fills a height the source never reported", () => {
    // The Breaking Bad case: 8 of 11 rows arrived with height 0, so the picker
    // could not label them and ranking could not order them.
    const out = withVerifiedHeight(
      { quality: "auto" },
      { ok: true, maxHeight: 1080, ladder: [1080, 720, 480] }
    );
    expect(out.maxHeight).toBe(1080);
    expect(out.ladder).toEqual([1080, 720, 480]);
    expect(out.quality).toBe("1080p");
  });

  it("never overwrites a measured probe", () => {
    // quality-probe.ts measures the stream itself; the master only advertises.
    const out = withVerifiedHeight(
      { quality: "720p", maxHeight: 720 },
      { ok: true, maxHeight: 1080, ladder: [1080] }
    );
    expect(out.maxHeight).toBe(720);
    expect(out.quality).toBe("720p");
  });

  it("does not turn a single rendition into a ladder", () => {
    // isMultiRendition treats a ladder as an adaptive source and ranks it
    // above single-rung ones; a one-entry master must not qualify.
    const out = withVerifiedHeight({ quality: "auto" }, { ok: true, maxHeight: 1080, ladder: [1080] });
    expect(out.maxHeight).toBe(1080);
    expect(out.ladder).toBeUndefined();
  });

  it("leaves the entry untouched when the master advertised nothing", () => {
    const entry = { quality: "auto" };
    expect(withVerifiedHeight(entry, { ok: true, maxHeight: 0, ladder: [] })).toBe(entry);
  });

  it("keeps an explicit quality label even when filling the height", () => {
    const out = withVerifiedHeight(
      { quality: "1080p" },
      { ok: true, maxHeight: 720, ladder: [720] }
    );
    expect(out.maxHeight).toBe(720);
    expect(out.quality).toBe("1080p");
  });

  it("records height from a failed verification too", () => {
    // A soft-kept row is still shown in the picker, so it still needs a label.
    const out = withVerifiedHeight({ quality: "auto" }, { ok: false, maxHeight: 480, ladder: [480] });
    expect(out.maxHeight).toBe(480);
  });
});
