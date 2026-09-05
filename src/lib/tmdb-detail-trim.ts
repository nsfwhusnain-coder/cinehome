/**
 * Trims a TMDB details payload down to what this app actually renders.
 *
 * Measured on `/api/tmdb/movie/402431`: 329 KB, of which `credits` was 163 KB
 * (396 cast + 227 crew) and `watch/providers` 72 KB. The movie detail view
 * renders `credits.cast.slice(0, 12)` and one crew entry (the Director), and
 * nothing in the app reads `watch/providers` at all.
 *
 * That payload is paid twice over: once as JSON for the client fetch, and again
 * serialized into the server-rendered HTML as `initialData` (which is why the
 * movie page shipped 479 KB of HTML). Every byte has to cross the wire, be
 * parsed, and be hydrated — which is felt hardest on a TV browser.
 *
 * Trimming happens at the `tmdb` client so both consumers benefit, and it is
 * deliberately generous: the caps sit well above what the UI slices, so a view
 * showing "more cast" later still has data without another round trip.
 */

/** UI slices 12; keep headroom so a layout change does not need a refetch. */
export const DETAIL_CAST_LIMIT = 20;
/** Only these crew jobs are ever displayed or searched for. */
export const DETAIL_CREW_JOBS: ReadonlySet<string> = new Set([
  "Director",
  "Creator",
  "Writer",
  "Screenplay",
  "Story",
  "Producer",
  "Executive Producer",
]);
/** Hard cap after job filtering — a big franchise can list many producers. */
export const DETAIL_CREW_LIMIT = 12;

interface CreditsLike {
  cast?: unknown[];
  crew?: { job?: string }[];
}

/**
 * Returns a copy with oversized, unrendered branches removed. Shape-preserving:
 * `credits` stays a `{ cast, crew }` object and missing keys stay missing, so
 * every existing optional-chain read behaves exactly as before.
 */
export function trimTmdbDetails<T extends object>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const next = { ...(data as Record<string, unknown>) };

  // Never read anywhere in the app; `tmdb.watchProviders()` exists for the
  // cases that genuinely need provider data.
  delete next["watch/providers"];

  const credits = next.credits as CreditsLike | undefined;
  if (credits && typeof credits === "object") {
    const cast = Array.isArray(credits.cast)
      ? credits.cast.slice(0, DETAIL_CAST_LIMIT)
      : credits.cast;
    const crew = Array.isArray(credits.crew)
      ? credits.crew
          .filter((member) => DETAIL_CREW_JOBS.has(member?.job ?? ""))
          .slice(0, DETAIL_CREW_LIMIT)
      : credits.crew;
    next.credits = { ...credits, ...(cast ? { cast } : {}), ...(crew ? { crew } : {}) };
  }

  return next as T;
}
