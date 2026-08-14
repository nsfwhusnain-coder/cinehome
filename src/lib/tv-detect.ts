/**
 * Television detection — one source of truth.
 *
 * Two detectors used to disagree here. `isTvLikeDevice()` in tv-navigation.ts
 * gated every living-room stylesheet and the whole spatial-navigation layer;
 * `detectDeviceClass()` in playback/device-profile.ts gated the media buffer
 * envelope. They carried different user-agent patterns, so a device could be
 * handed the TV buffer profile while still getting the desktop layout and no
 * remote support, or the exact reverse.
 *
 * Both now come through this module, and a user agent is no longer the only way
 * to be recognised. That second point is the important one: a television that
 * reports plain Chrome — Android TV, most Google TV panels, and anything
 * launched from a homescreen shortcut through a WebView — matched neither old
 * pattern, so `html[data-tv="1"]` was never set and every living-room rule in
 * globals.css sat inert while the set rendered the laptop layout at laptop type
 * sizes with no D-pad handling at all.
 */

export type TvReason = "override" | "user-agent" | "input-profile" | "none";

/**
 * Union of the two patterns this replaces, plus the platforms neither carried:
 * Chromecast/Google TV, Android TV, Fire TV, Philips/NetTV, VIDAA (Hisense) and
 * Opera TV. Bare vendor names that also ship phones (Hisense) are deliberately
 * absent — `vidaa` identifies the panel without catching the handset.
 */
const TV_USER_AGENT =
  /web[o0]s|webappmanager|tizen|smart-?tv|hbbtv|netcast|bravia|viera|aquos|crkey|chromecast|google\s?tv|android\s?tv|fire\s?tv|philips\s?tv|nettv|vidaa|opera\s?tv|inettvbrowser|sonydtv|dlnadoc/i;

/**
 * Fire TV device codes, matched case-sensitively and separately.
 *
 * The list this replaces was `aft[bmst]`, which covers four of the codes
 * Amazon actually ships — a current Fire TV Stick reports AFTKA and matched
 * nothing. Widening it inside the case-insensitive pattern above would make
 * `aft` followed by any letters match, and "after" is a word; Amazon always
 * uppercases the token, so testing for case is what makes the wider match safe.
 */
const FIRE_TV_DEVICE = /\bAFT[A-Z0-9]{1,8}\b/;

/**
 * Below this the input-profile heuristic stays out of it. A remote-driven panel
 * is always a large canvas; anything narrower answering the same input queries
 * is more likely a kiosk or an unusual tablet, and the cost of guessing wrong
 * there is a phone-sized screen wearing 40px type.
 */
const TV_MIN_VIEWPORT_WIDTH_PX = 1280;

/** Survives the query string being dropped by a homescreen shortcut. */
const OVERRIDE_STORAGE_KEY = "cinehome.tv-mode";

/** Classify from a user-agent string. Pure, so it tests without a DOM. */
export function isTvUserAgent(userAgent: string): boolean {
  if (TV_USER_AGENT.test(userAgent) || FIRE_TV_DEVICE.test(userAgent)) {
    return true;
  }
  // Hisense panels often omit VIDAA and just say "Hisense". Phones always
  // include Mobile; an 85-inch set never does.
  return /hisense/i.test(userAgent) && !/mobile/i.test(userAgent);
}

/**
 * True when the browser reports no pointing device of any kind and no touch
 * screen, across every input mechanism attached.
 *
 * A desktop answers `any-hover: hover` and `any-pointer: fine`. A phone or
 * tablet answers neither but reports touch points. A remote-driven television
 * is the only class that answers neither and has no touch either — a D-pad is
 * not a pointer, so the media queries a TV browser answers are precisely the
 * ones nothing else answers the same way.
 */
export function hasTvInputProfile(
  viewportWidthPx: number,
  hoverCapable: boolean,
  finePointer: boolean,
  touchPoints: number
): boolean {
  if (viewportWidthPx < TV_MIN_VIEWPORT_WIDTH_PX) return false;
  return !hoverCapable && !finePointer && touchPoints === 0;
}

function readStoredOverride(): boolean | null {
  try {
    const stored = window.localStorage.getItem(OVERRIDE_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Private-mode TV browsers throw on localStorage. Not a reason to fail.
  }
  return null;
}

function persistOverride(enabled: boolean): void {
  try {
    window.localStorage.setItem(OVERRIDE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Same: the override still applies for this session via the query string.
  }
}

/**
 * `?tv=1` forces TV mode on, `?tv=0` forces it off, and either choice is
 * remembered. Without the memory the escape hatch would be useless in the one
 * place it matters most — a shortcut pinned to a TV home screen usually
 * re-launches the bare origin with no query string, so a setting applied once
 * would silently lapse on the next launch.
 */
function readOverride(): boolean | null {
  const forced = new URLSearchParams(window.location.search).get("tv");
  if (forced === "1" || forced === "0") {
    const enabled = forced === "1";
    persistOverride(enabled);
    return enabled;
  }
  return readStoredOverride();
}

function detect(): { isTv: boolean; reason: TvReason } {
  const override = readOverride();
  if (override !== null) return { isTv: override, reason: "override" };

  if (isTvUserAgent(window.navigator.userAgent || "")) {
    return { isTv: true, reason: "user-agent" };
  }

  const media =
    typeof window.matchMedia === "function"
      ? {
          hover: window.matchMedia("(any-hover: hover)").matches,
          fine: window.matchMedia("(any-pointer: fine)").matches,
        }
      : { hover: true, fine: true };
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const touchPoints = window.navigator.maxTouchPoints ?? 0;

  if (hasTvInputProfile(width, media.hover, media.fine, touchPoints)) {
    return { isTv: true, reason: "input-profile" };
  }
  return { isTv: false, reason: "none" };
}

/** Cached — the device class cannot change mid-session and callers sit in hot paths. */
let cache: { isTv: boolean; reason: TvReason } | null = null;

export function tvDetection(): { isTv: boolean; reason: TvReason } {
  if (cache) return cache;
  if (typeof window === "undefined") return { isTv: false, reason: "none" };
  cache = detect();
  return cache;
}

export function isTvLikeDevice(): boolean {
  return tvDetection().isTv;
}

/** Test seam. Production code never needs to clear the cache. */
export function resetTvDetectionCache(): void {
  cache = null;
}

/**
 * The same decision, as a blocking inline script for the document head.
 *
 * React can only set `data-tv` in an effect, which runs after the first paint.
 * On a television that is not a subtle detail: the root font size doubles when
 * the marker lands, so the set draws a full page of laptop-sized text and then
 * reflows the entire document. Deciding before the first paint removes the
 * flash and the reflow with it.
 *
 * The pattern and both thresholds are interpolated from the constants above
 * rather than restated, so this cannot drift away from `detect()`. It is built
 * on the server and must stay free of anything but ES5 — some living-room
 * browsers parse the head with an older engine than they run modules with.
 */
export function tvDetectionBootstrapScript(): string {
  return `(function(){try{var d=document.documentElement,o=null;try{
var p=new URLSearchParams(location.search).get("tv");
if(p==="1"||p==="0"){o=p==="1";localStorage.setItem(${JSON.stringify(OVERRIDE_STORAGE_KEY)},p)}
else{var s=localStorage.getItem(${JSON.stringify(OVERRIDE_STORAGE_KEY)});if(s==="1"||s==="0")o=s==="1"}
}catch(e){}
var t=o;
if(t===null){var u=navigator.userAgent||"";
t=new RegExp(${JSON.stringify(TV_USER_AGENT.source)},"i").test(u)||new RegExp(${JSON.stringify(FIRE_TV_DEVICE.source)}).test(u);
if(!t)t=/hisense/i.test(u)&&!/mobile/i.test(u);
if(!t){var w=window.innerWidth||d.clientWidth||0;
t=w>=${TV_MIN_VIEWPORT_WIDTH_PX}&&!matchMedia("(any-hover: hover)").matches&&!matchMedia("(any-pointer: fine)").matches&&(navigator.maxTouchPoints||0)===0}}
if(t)d.setAttribute("data-tv","1")}catch(e){}})()`;
}
