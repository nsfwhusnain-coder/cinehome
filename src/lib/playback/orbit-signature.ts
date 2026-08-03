/**
 * Per-title orbital signature.
 *
 * The loading screen previously varied only its hue, so every film produced an
 * identical system in a different colour. These derive the orbit's geometry
 * from the title itself, so Dune and Fight Club have visibly different systems
 * — different tilt, different speed, different starting positions — while any
 * given title looks the same every time you open it.
 *
 * Deterministic by construction: the same id always yields the same numbers.
 * Nothing here is random, because a system that reshuffled on every re-render
 * would read as noise rather than identity.
 */

/** Orbital plane tilt, degrees. Shallow enough that planets stay near-circular. */
const TILT_MIN = 14;
const TILT_MAX = 34;
/** Seconds for one revolution. Slow — this is ambient, not a spinner. */
const PERIOD_MIN_S = 26;
const PERIOD_MAX_S = 44;
/** Where the first planet starts, degrees. */
const PHASE_MAX = 360;

export interface OrbitSignature {
  /** Plane tilt in degrees. */
  tiltDeg: number;
  /** Revolution period in seconds. */
  periodS: number;
  /** Rotation offset of the whole system, degrees. */
  phaseDeg: number;
}

/**
 * FNV-1a. Chosen for being tiny, dependency-free and well-distributed over
 * short numeric strings — a plain sum would cluster adjacent TMDB ids onto
 * near-identical geometry, which is exactly what this exists to avoid.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Map a hash slice into [min, max]. */
function spread(value: number, min: number, max: number): number {
  return min + (value % 1000) / 1000 * (max - min);
}

/**
 * Geometry for a title. `seed` should be stable per title — the TMDB id, or
 * the id plus season/episode so a series still reads as one family while its
 * episodes differ slightly.
 */
export function orbitSignature(seed: string): OrbitSignature {
  const h = hash32(seed || "cinehome");
  return {
    tiltDeg: Math.round(spread(h, TILT_MIN, TILT_MAX) * 10) / 10,
    periodS: Math.round(spread(h >>> 7, PERIOD_MIN_S, PERIOD_MAX_S) * 10) / 10,
    phaseDeg: Math.round(spread(h >>> 13, 0, PHASE_MAX)),
  };
}
