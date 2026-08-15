/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  nearestPreviewFrame,
  previewBucket,
} from "./hover-preview";

describe("previewBucket", () => {
  it("snaps to 2-second marks", () => {
    expect(previewBucket(0)).toBe(0);
    expect(previewBucket(0.4)).toBe(0);
    expect(previewBucket(1.2)).toBe(2);
    expect(previewBucket(13.4)).toBe(14);
  });

  it("treats junk as zero", () => {
    expect(previewBucket(Number.NaN)).toBe(0);
    expect(previewBucket(-4)).toBe(0);
  });
});

describe("nearestPreviewFrame", () => {
  it("returns the closest stored frame inside the window", () => {
    const frames = new Map<number, string>([
      [10, "a"],
      [20, "b"],
    ]);
    expect(nearestPreviewFrame(frames, 11)).toBe("a");
    expect(nearestPreviewFrame(frames, 18)).toBe("b");
  });

  it("returns null when nothing is near", () => {
    const frames = new Map<number, string>([[0, "start"]]);
    expect(nearestPreviewFrame(frames, 90)).toBeNull();
    expect(nearestPreviewFrame(new Map(), 10)).toBeNull();
  });
});
