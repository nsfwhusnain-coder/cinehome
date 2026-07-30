/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { safariHintFor } from "./index";

/**
 * "· Safari" is a claim about which browsers can play a source. It used to be
 * driven by `compat`, which conflates two unrelated things: a codec Chrome
 * cannot decode, and an MKV container. Now that MKV is remuxed and plays
 * everywhere, that conflation labels the best 4K sources as unusable — which
 * is precisely what "no 4K available for such a popular movie" looked like.
 */
describe("safariHintFor", () => {
  it("keeps the tag for HEVC — genuinely Safari-only, whatever the container", () => {
    expect(safariHintFor("safari", "hevc")).toBe(" · Safari");
    // Even a record whose compat was never set: the codec is the real constraint.
    expect(safariHintFor("native", "hevc")).toBe(" · Safari");
  });

  it("drops the tag for H.264 — it plays in every browser, remuxed if it's an MKV", () => {
    expect(safariHintFor("safari", "h264")).toBe("");
  });

  it("drops the tag for AV1, where 'Safari' would be exactly backwards", () => {
    // AV1 is Chrome/Firefox; older Safari is the one browser that can't.
    expect(safariHintFor("safari", "av1")).toBe("");
  });

  it("falls back to compat when the codec is unknown — no evidence to overrule it", () => {
    expect(safariHintFor("safari", "unknown")).toBe(" · Safari");
    expect(safariHintFor("native", "unknown")).toBe("");
    expect(safariHintFor(null)).toBe("");
  });
});
