import { describe, expect, it } from "bun:test";
import { hasTvInputProfile, isTvUserAgent } from "./tv-detect";

const LG_C5 =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/108.0.5359.128 Safari/537.36 WebAppManager";
const SAMSUNG_TIZEN =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/7.0 TV Safari/537.36";
const SHIELD_ANDROID_TV =
  "Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A.210105.003) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROMECAST_GOOGLE_TV =
  "Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE.240206.002) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FIRE_TV_STICK =
  "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36";
const HISENSE_VIDAA =
  "Mozilla/5.0 (Linux; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 " +
  "Safari/537.36 VIDAA/6.0";
const HISENSE_PANEL =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/91.0.4472.114 Safari/537.36 Hisense";
const HISENSE_PHONE =
  "Mozilla/5.0 (Linux; Android 12; Hisense H50) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Mobile Safari/537.36";

describe("isTvUserAgent", () => {
  it("matches the platforms the old pattern already covered", () => {
    expect(isTvUserAgent(LG_C5)).toBe(true);
    expect(isTvUserAgent(SAMSUNG_TIZEN)).toBe(true);
  });

  it("matches the Android-derived platforms the old pattern missed", () => {
    // These report as ordinary Chrome apart from the device token, which is why
    // they used to fall through to the desktop layout with no remote support.
    expect(isTvUserAgent(SHIELD_ANDROID_TV)).toBe(true);
    expect(isTvUserAgent(CHROMECAST_GOOGLE_TV)).toBe(true);
    expect(isTvUserAgent(FIRE_TV_STICK)).toBe(true);
    expect(isTvUserAgent(HISENSE_VIDAA)).toBe(true);
    expect(isTvUserAgent(HISENSE_PANEL)).toBe(true);
  });

  it("does not mistake a desktop or a phone for a television", () => {
    expect(isTvUserAgent(DESKTOP_CHROME)).toBe(false);
    expect(isTvUserAgent(IPHONE)).toBe(false);
    // Bare Android must not match: only the TV device tokens do.
    expect(isTvUserAgent(ANDROID_PHONE)).toBe(false);
    expect(isTvUserAgent(HISENSE_PHONE)).toBe(false);
  });

  it("does not let the Fire TV pattern match an English word", () => {
    // AFT* is matched case-sensitively precisely so that "after" cannot trip
    // it. Lower-casing that check would hand a desktop the living-room layout.
    expect(isTvUserAgent("Mozilla/5.0 shortly after release")).toBe(false);
    expect(isTvUserAgent("aftka")).toBe(false);
  });

  it("treats an unrecognised agent as not a television", () => {
    expect(isTvUserAgent("")).toBe(false);
    expect(isTvUserAgent("something/1.0")).toBe(false);
  });
});

describe("hasTvInputProfile", () => {
  const TV_1080P = 1920;
  const TV_4K = 3840;

  it("accepts a large viewport with no pointer and no touch", () => {
    // The signature of a set driven by a D-pad: nothing can hover, nothing is
    // fine, and there is no touchscreen either.
    expect(hasTvInputProfile(TV_1080P, false, false, 0)).toBe(true);
    expect(hasTvInputProfile(TV_4K, false, false, 0)).toBe(true);
  });

  it("rejects a desktop, which always reports hover and a fine pointer", () => {
    expect(hasTvInputProfile(2560, true, true, 0)).toBe(false);
  });

  it("rejects a touchscreen even at television width", () => {
    // A large tablet or a touch-enabled monitor answers the pointer queries the
    // same way a TV does; the touch points are what separate them.
    expect(hasTvInputProfile(TV_1080P, false, false, 5)).toBe(false);
  });

  it("rejects anything below the minimum viewport width", () => {
    expect(hasTvInputProfile(1279, false, false, 0)).toBe(false);
  });

  it("rejects a device that can hover even without a fine pointer", () => {
    expect(hasTvInputProfile(TV_1080P, true, false, 0)).toBe(false);
  });
});
