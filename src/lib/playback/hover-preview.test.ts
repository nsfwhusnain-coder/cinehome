/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { nearestPreviewFrame, previewBucket } from "./hover-preview";

describe("hover-preview ring buffer", () => {
  it("buckets timestamps on 2s intervals", () => {
    expect(previewBucket(0)).toBe(0);
    expect(previewBucket(1.4)).toBe(2);
    expect(previewBucket(2.9)).toBe(2);
    expect(previewBucket(3.1)).toBe(4);
  });

  it("finds nearest cached frame within distance limit", () => {
    const frames = new Map<number, string>();
    frames.set(10, "data:image/jpeg;base64,frame10");
    frames.set(20, "data:image/jpeg;base64,frame20");

    expect(nearestPreviewFrame(frames, 11)).toBe("data:image/jpeg;base64,frame10");
    expect(nearestPreviewFrame(frames, 19)).toBe("data:image/jpeg;base64,frame20");
    expect(nearestPreviewFrame(frames, 50, 10)).toBeNull();
  });
});
