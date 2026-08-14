import { afterEach, describe, expect, it } from "bun:test";
import {
  hevcNeedsNativePath,
  resetDecodeCapabilityCache,
  supportsHevc,
  warmDecodeCapabilities,
} from "./decode-capability";

/**
 * Regression cover for the two ways a browser that CAN decode HEVC was told it
 * could not. Both were caching faults rather than detection faults, and both
 * surfaced to the viewer as "HEVC is not supported by this browser" on a
 * roster the browser could actually play.
 *
 * There is no DOM here, so `typeof window === "undefined"` and the synchronous
 * probe answers "no" — which is exactly the server-render condition these
 * tests need to reproduce.
 */

type Mutable = Record<string, unknown>;

function installFakeBrowser(mseAnswer: boolean): void {
  (globalThis as Mutable).window = {};
  (globalThis as Mutable).MediaSource = {
    isTypeSupported: () => mseAnswer,
  };
}

function installMediaCapabilities(supported: boolean): void {
  (globalThis as Mutable).navigator = {
    mediaCapabilities: {
      decodingInfo: async () => ({ supported, powerEfficient: supported }),
    },
  };
}

afterEach(() => {
  delete (globalThis as Mutable).window;
  delete (globalThis as Mutable).MediaSource;
  delete (globalThis as Mutable).navigator;
  delete (globalThis as Mutable).document;
  resetDecodeCapabilityCache();
});

describe("server-side probe is never cached", () => {
  it("does not latch a windowless 'unsupported' into the module cache", () => {
    // isSourcePlayableHere runs on the playback API route inside a
    // long-lived Node process. Caching that answer would mark the whole
    // HEVC tier ineligible for every request that process served afterwards.
    expect(supportsHevc()).toBe(false);

    installFakeBrowser(true);
    expect(supportsHevc()).toBe(true);
  });

  it("still caches a real browser answer", () => {
    installFakeBrowser(true);
    expect(supportsHevc()).toBe(true);

    // Cached: flipping the underlying probe must not change the answer.
    (globalThis as Mutable).MediaSource = { isTypeSupported: () => false };
    expect(supportsHevc()).toBe(true);
  });
});

describe("living-room HEVC trust", () => {
  it("treats a Hisense panel as HEVC-capable even when canPlayType is empty", () => {
    // VIDAA Chrome 76 answers "" for every hvc1 string. That used to hide
    // every 4K HEVC release on the 85-inch set.
    installFakeBrowser(false);
    (globalThis as Mutable).navigator = {
      userAgent:
        "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/91.0.4472.114 Safari/537.36 Hisense",
    };
    expect(supportsHevc()).toBe(true);
  });

  it("also trusts the data-tv marker when the UA is disguised", () => {
    installFakeBrowser(false);
    (globalThis as Mutable).navigator = { userAgent: "Mozilla/5.0 Chrome/76.0" };
    (globalThis as Mutable).document = {
      documentElement: { getAttribute: (name: string) => (name === "data-tv" ? "1" : null) },
    };
    expect(supportsHevc()).toBe(true);
  });
});

const HISENSE_VIDAA =
  "Mozilla/5.0 (Linux; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 " +
  "Safari/537.36 VIDAA/6.0";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

describe("hevcNeedsNativePath living-room MSE gap", () => {
  it("takes the native path on Hisense when MSE rejects every HEVC probe", () => {
    installFakeBrowser(false);
    (globalThis as Mutable).navigator = { userAgent: HISENSE_VIDAA };
    (globalThis as Mutable).document = {
      createElement: () => ({ canPlayType: () => "" }),
      documentElement: { getAttribute: () => null },
    };
    expect(hevcNeedsNativePath()).toBe(true);
  });

  it("does not take the native path on desktop Chrome with no MSE and no element HEVC", () => {
    installFakeBrowser(false);
    (globalThis as Mutable).navigator = { userAgent: DESKTOP_CHROME };
    (globalThis as Mutable).document = {
      createElement: () => ({ canPlayType: () => "" }),
      documentElement: { getAttribute: () => null },
    };
    expect(hevcNeedsNativePath()).toBe(false);
  });

  it("takes the native path when data-tv=1 and MSE rejects HEVC", () => {
    installFakeBrowser(false);
    (globalThis as Mutable).navigator = { userAgent: DESKTOP_CHROME };
    (globalThis as Mutable).document = {
      createElement: () => ({ canPlayType: () => "" }),
      documentElement: { getAttribute: (name: string) => (name === "data-tv" ? "1" : null) },
    };
    expect(hevcNeedsNativePath()).toBe(true);
  });
});

describe("warmDecodeCapabilities upgrades a conservative answer", () => {
  it("turns support ON when mediaCapabilities confirms 4K decode", async () => {
    // The string matrix can be too conservative — that is the entire reason
    // the async refinement exists. Before this fix source-quality.ts wrapped
    // the answer in a second permanent cache, latched the pre-warm "no", and
    // discarded the correction for the rest of the session.
    installFakeBrowser(false);
    expect(supportsHevc()).toBe(false);

    installMediaCapabilities(true);
    await warmDecodeCapabilities();

    expect(supportsHevc()).toBe(true);
  });

  it("never turns a working codec OFF", async () => {
    installFakeBrowser(true);
    expect(supportsHevc()).toBe(true);

    installMediaCapabilities(false);
    await warmDecodeCapabilities();

    // A browser that accepts the codec string and plays it in practice must
    // not lose its roster to a stricter secondary opinion.
    expect(supportsHevc()).toBe(true);
  });
});
