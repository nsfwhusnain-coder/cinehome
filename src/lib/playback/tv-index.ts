/**
 * Season/episode query value. Season 0 is TMDB specials — truthiness
 * (`season &&` / `season < 1`) used to map those to S1.
 * Missing, NaN, or negative → 1. Zero stays zero.
 */
export function tvQueryIndex(value?: number | null): number {
  return value != null && Number.isFinite(value) && value >= 0 ? value : 1;
}
