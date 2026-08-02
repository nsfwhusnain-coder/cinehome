import { describe, expect, it } from "bun:test";
import { bufferProfileFor, deviceClassFromUserAgent } from "./device-profile";

const LG_C5 =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/108.0.5359.128 Safari/537.36 WebAppManager";
const SAMSUNG =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/7.0 TV Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("deviceClassFromUserAgent", () => {
  it("classifies the LG C5 webOS browser as a TV", () => {
    // webOS spells itself "Web0S" with a zero on several firmware generations.
    expect(deviceClassFromUserAgent(LG_C5)).toBe("tv");
  });

  it("classifies Tizen as a TV", () => {
    expect(deviceClassFromUserAgent(SAMSUNG)).toBe("tv");
  });

  it("leaves desktop Chrome on the desktop profile", () => {
    expect(deviceClassFromUserAgent(DESKTOP_CHROME)).toBe("desktop");
  });

  it("does not mistake a phone for a TV", () => {
    expect(deviceClassFromUserAgent(IPHONE)).toBe("desktop");
  });

  it("falls back to desktop for an unrecognised agent", () => {
    // Unknown UAs must keep the behaviour that shipped before this existed.
    expect(deviceClassFromUserAgent("")).toBe("desktop");
    expect(deviceClassFromUserAgent("something/1.0")).toBe("desktop");
  });
});

describe("bufferProfileFor", () => {
  it("leaves the desktop envelope exactly as it was", () => {
    expect(bufferProfileFor("desktop")).toEqual({
      maxBufferLengthS: 30,
      maxMaxBufferLengthS: 60,
      maxBufferSizeBytes: 64_000_000,
      backBufferLengthS: 30,
      abrInitialEstimateBps: 10_000_000,
    });
  });

  it("gives a TV a materially smaller memory envelope", () => {
    const tv = bufferProfileFor("tv");
    const desktop = bufferProfileFor("desktop");
    expect(tv.maxBufferSizeBytes).toBeLessThan(desktop.maxBufferSizeBytes / 2);
    expect(tv.maxMaxBufferLengthS).toBeLessThan(desktop.maxMaxBufferLengthS);
    expect(tv.backBufferLengthS).toBeLessThan(desktop.backBufferLengthS);
  });

  it("opens ABR lower on a TV so an over-reach cannot trigger the collapse", () => {
    expect(bufferProfileFor("tv").abrInitialEstimateBps).toBeLessThan(
      bufferProfileFor("desktop").abrInitialEstimateBps
    );
  });

  it("still buffers enough on a TV to ride out a proxy hiccup", () => {
    // Too small and every double-hop stall becomes a rebuffer.
    expect(bufferProfileFor("tv").maxBufferLengthS).toBeGreaterThanOrEqual(10);
  });
});
