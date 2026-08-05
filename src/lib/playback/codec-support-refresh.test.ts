import { afterEach, describe, expect, it } from "bun:test";
import {
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
  resetDecodeCapabilityCache();
});

describe("server-side probe is never cached", () => {
  it("does not latch a windowless 'unsupported' into the module cache", () => {
    // buildCoordinatorShadowDecision calls isSourcePlayableHere from the
    // playback API route, so this path runs inside a long-lived Node process.
    // Caching its answer would mark the whole HEVC tier ineligible for every
    // request that process served afterwards.
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
