import { describe, expect, it } from "bun:test";
import { hevcNeedsNativePath, HEVC_PROBE_TYPES } from "./decode-capability";

/**
 * hevcNeedsNativePath decides whether the player forfeits its quality floor.
 * It must only answer true in the one case that justifies the cost: HEVC
 * reachable through <video> but not through MSE.
 */
describe("hevcNeedsNativePath", () => {
  const realMediaSource = globalThis.MediaSource;
  const realDocument = globalThis.document;

  function withEnvironment(
    mseSupports: boolean | null,
    elementSupports: boolean
  ): boolean {
    // @ts-expect-error swapping globals for the duration of the assertion
    globalThis.MediaSource =
      mseSupports === null
        ? undefined
        : { isTypeSupported: () => mseSupports };
    // @ts-expect-error minimal stub — only canPlayType is consulted
    globalThis.document = {
      createElement: () => ({
        canPlayType: () => (elementSupports ? "probably" : ""),
      }),
    };
    try {
      return hevcNeedsNativePath();
    } finally {
      // @ts-expect-error restoring the real globals
      globalThis.MediaSource = realMediaSource;
      // @ts-expect-error restoring the real globals
      globalThis.document = realDocument;
    }
  }

  it("takes the native path when only the video element can decode HEVC", () => {
    // The one case worth losing the quality floor for.
    expect(withEnvironment(false, true)).toBe(true);
  });

  it("keeps hls.js when MSE can carry HEVC, so the floor still applies", () => {
    // Previously every TV surrendered the floor here merely for answering
    // canPlayType on m3u8.
    expect(withEnvironment(true, true)).toBe(false);
  });

  it("keeps hls.js when neither transport decodes HEVC", () => {
    // Nothing to gain natively; the floor is strictly better.
    expect(withEnvironment(false, false)).toBe(false);
  });

  it("keeps hls.js when MediaSource is absent but the element cannot decode", () => {
    expect(withEnvironment(null, false)).toBe(false);
  });

  it("probes more than the one narrow codec string", () => {
    // A single Main-8-bit-L3.1 probe was the original 4K detection bug.
    expect(HEVC_PROBE_TYPES.length).toBeGreaterThan(4);
  });
});
