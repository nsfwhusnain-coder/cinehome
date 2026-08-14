import { describe, expect, it } from "bun:test";
import { hevcNeedsNativePath, HEVC_PROBE_TYPES } from "./decode-capability";
import { shouldUseNativeHlsOnTv } from "./hls-engine";

/**
 * hevcNeedsNativePath: capability only.
 * Desktop: true iff HEVC is on <video> and not MSE.
 * TV: also true when MSE rejects HEVC (VIDAA answers "" for every hvc1 string).
 *
 * shouldUseNativeHlsOnTv is the engine gate: native <video src> only for
 * HEVC remux on that TV. H.264 stays on hls.js even when hevcNeedsNative.
 */
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

describe("hevcNeedsNativePath", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const realMediaSource = globals.MediaSource;
  const realDocument = globals.document;
  const realNavigator = globals.navigator;

  function withEnvironment(
    mseSupports: boolean | null,
    elementSupports: boolean,
    userAgent = DESKTOP_CHROME
  ): boolean {
    globals.MediaSource =
      mseSupports === null
        ? undefined
        : { isTypeSupported: () => mseSupports };
    globals.document = {
      createElement: () => ({
        canPlayType: () => (elementSupports ? "probably" : ""),
      }),
      documentElement: { getAttribute: () => null },
    };
    globals.navigator = { userAgent };
    try {
      return hevcNeedsNativePath();
    } finally {
      globals.MediaSource = realMediaSource;
      globals.document = realDocument;
      globals.navigator = realNavigator;
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

describe("shouldUseNativeHlsOnTv", () => {
  it("keeps hls.js for H.264 on a TV that needs a native HEVC path", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "h264",
      })
    ).toBe(false);
  });

  it("takes native for HEVC remux on that same TV", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "hevc",
        delivery: "remux",
      })
    ).toBe(true);
  });

  it("treats untagged debrid safari-compat as HEVC", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "unknown",
        origin: "debrid",
        compat: "safari",
      })
    ).toBe(true);
  });

  it("treats untagged remux as HEVC on TV", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "unknown",
        delivery: "remux",
      })
    ).toBe(true);
  });

  it("does not take native for H.264 remux", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "h264",
        delivery: "remux",
      })
    ).toBe(false);
  });

  it("does not take native for unknown embed HLS (Luna)", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: true,
        codec: "unknown",
        origin: "embed",
        delivery: "direct",
      })
    ).toBe(false);
  });

  it("stays off native when MSE already carries HEVC", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: true,
        hevcNeedsNative: false,
        codec: "hevc",
        delivery: "remux",
      })
    ).toBe(false);
  });

  it("leaves desktop on hls.js even for HEVC remux", () => {
    expect(
      shouldUseNativeHlsOnTv({
        isTv: false,
        hevcNeedsNative: true,
        codec: "hevc",
        delivery: "remux",
      })
    ).toBe(false);
  });
});
