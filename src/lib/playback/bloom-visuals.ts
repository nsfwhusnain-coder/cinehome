/**
 * Pure visual mapping for the Spectrum Bloom loading screen.
 *
 * Everything the old screen said in words — stage, source count, which source
 * of how many, the premium tier — is carried here as light instead. Kept
 * separate from the component so each mapping is testable without a DOM, and
 * so the honesty rule the old screen held to survives the redesign: nothing
 * below invents state the player does not actually have.
 */

import type { PlaybackSource } from "./types";

export type BloomPhase = "searching" | "connecting" | "buffering";

/** Hue only — the API returns a deliberately darkened tint (see the ambient
 * hook), which is right for a background wash and far too muddy for a light
 * source. Taking the hue and re-saturating in CSS keeps the film's identity
 * without inheriting the darkening. */
const HUE_MAX = 360;

/** Neutral fallback when a poster yields no usable hue. Matches the brand's
 * violet-biased neutrals rather than a dead grey. */
export const FALLBACK_HUE = 280;

/**
 * Hue in degrees from a `#rrggbb` string, or null when the input is not a hex
 * colour. Greys return null rather than 0 — a hue of red would be a lie.
 */
export function hexToHue(hex: string): number | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  return ((hue % HUE_MAX) + HUE_MAX) % HUE_MAX;
}

/**
 * TMDB image path out of a rendered image URL, for `/api/poster-color?path=`.
 * The loading screen receives a full URL from the watch view, while the colour
 * endpoint wants the bare path — deriving it here avoids threading a second
 * prop through the player for the same picture.
 */
export function tmdbPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/t\/p\/[^/]+(\/[A-Za-z0-9._-]+\.(?:jpg|png|webp))$/i);
  return match ? match[1] : null;
}

/**
 * The same TMDB image at a different rendition, or the input unchanged when it
 * is not a TMDB URL.
 *
 * Used to hand televisions a deliberately small backdrop. The loading art is
 * meant to be defocused, and a `filter: blur()` over a full-bleed image is one
 * of the most expensive things a TV browser can be asked to do — so expensive
 * that the TV branch used to switch the blur off entirely and leave a sharp
 * backdrop sitting behind glass that exists to refract it, which is what made
 * the screen look wrong on a television rather than merely plainer. Requesting
 * a small rendition and letting the panel scale it up gives the same softness
 * for free, and decodes a fraction of the pixels while the player is at its
 * busiest.
 */
export function tmdbUrlAtSize(
  url: string | null | undefined,
  size: string
): string | null {
  if (!url) return null;
  const match = url.match(/^(https?:\/\/[^/]+\/t\/p\/)[^/]+(\/.+)$/i);
  return match ? `${match[1]}${size}${match[2]}` : url;
}

/**
 * Which phase the bloom is in.
 *
 * Deliberately the same signals the previous stage rail keyed off, so the
 * visual never claims a stage the old copy would not have shown. `status` is
 * the player's own computed line (see `loadingStatus` in video-player.tsx);
 * we read it rather than re-deriving, so the two can never disagree.
 */
export function bloomPhase(status: string | null, sourceCount: number): BloomPhase {
  const lower = (status ?? "").toLowerCase();
  if (/buffer/.test(lower)) return "buffering";
  if (/connect|preparing|resolv|repackag/.test(lower)) return "connecting";
  if (sourceCount > 0 && /choos|found/.test(lower)) return "connecting";
  return "searching";
}

export interface BloomCopyContext {
  /** Ultra is holding for a 4K source. */
  waitingForFourK?: boolean;
  /** Visible time on the title card. Copy may soften; fill never uses this. */
  elapsedMs?: number;
}

export const BLOOM_LONG_WAIT_MS = 8_000;

export const BLOOM_STEPS = ["Find", "Prepare", "Open"] as const;

export function bloomStepIndex(phase: BloomPhase): 0 | 1 | 2 {
  if (phase === "buffering") return 2;
  if (phase === "connecting") return 1;
  return 0;
}

/** Honest, short title-card copy. Never a fake percent. */
export function bloomPhaseCopy(
  phase: BloomPhase,
  ctx: BloomCopyContext = {}
): string {
  const fourK = Boolean(ctx.waitingForFourK);
  const longWait = (ctx.elapsedMs ?? 0) >= BLOOM_LONG_WAIT_MS;
  if (phase === "buffering") return fourK ? "Opening 4K" : "Opening";
  if (phase === "connecting") return fourK ? "Preparing 4K" : "Getting ready";
  if (fourK) return longWait ? "Still looking for 4K" : "Finding 4K";
  return longWait ? "Still looking" : "Finding a stream";
}

/**
 * Honest meter fill. Searching grows with real sources found; connecting and
 * opening use the measured buffer. Never invents a percent from a timer.
 */
export function bloomMeterProgress(
  phase: BloomPhase,
  sourceCount: number,
  bufferFill: number
): number {
  const sources = Math.max(0, Math.floor(sourceCount));
  const buffer = Math.min(1, Math.max(0, bufferFill));
  if (phase === "searching") {
    return Math.min(0.36, 0.1 + sources * 0.04);
  }
  if (phase === "connecting") {
    return Math.min(0.72, 0.4 + buffer * 0.28);
  }
  return Math.min(1, 0.68 + buffer * 0.32);
}

/** Roster line — omitted entirely until a real source exists. */
export function bloomRosterCopy(sourceCount: number): string | null {
  const n = Math.max(0, Math.floor(sourceCount));
  if (n <= 0) return null;
  return n === 1 ? "1 source" : `${n} sources`;
}

/** Beyond this the ring stops reading as countable and starts reading as texture. */
export const MAX_CHIPS = 12;

export interface BloomChip {
  /** Stable slot, so a chip never jumps position as the roster grows. */
  index: number;
  /** Premium 4K tier — Poseidon / Hades. Rendered larger and brighter. */
  premium: boolean;
  /** The source being attached right now. Rendered white. */
  chosen: boolean;
}

/**
 * One chip per source found, capped. Premium chips are placed first so the
 * tier stays visible even when the roster overflows the cap — losing a 4K
 * marker to a truncation rule would misreport what the player actually has.
 */
export function bloomChips(
  sourceCount: number,
  premiumCount: number,
  chosenIndex: number
): BloomChip[] {
  const total = Math.min(Math.max(0, Math.floor(sourceCount)), MAX_CHIPS);
  const premium = Math.min(Math.max(0, Math.floor(premiumCount)), total);
  const chips: BloomChip[] = [];
  for (let index = 0; index < total; index += 1) {
    chips.push({
      index,
      premium: index < premium,
      chosen: index === chosenIndex && chosenIndex >= 0 && chosenIndex < total,
    });
  }
  return chips;
}

/** Sources that earn the premium marker: the debrid 4K tier, nothing else. */
export function premiumSourceCount(sources: readonly PlaybackSource[]): number {
  let count = 0;
  for (const source of sources) {
    const height = source.maxHeight ?? 0;
    if (source.origin === "debrid" && height >= 2160) count += 1;
  }
  return count;
}
