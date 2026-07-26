/**
 * Browser-pool sizing policy.
 *
 * Each warm Playwright browser owns several Chromium processes and a busy
 * page can consume multiple CPU cores. Keep the production default modest;
 * the shared pool still lets separate title enrichments queue without
 * spawning an unbounded browser per request.
 */
export const BROWSER_POOL_DEFAULT = 1;
export const BROWSER_POOL_MIN = 1;
export const BROWSER_POOL_MAX = 4;

export function browserPoolSize(raw: string | undefined): number {
  const parsed = Number(raw);
  const requested =
    Number.isFinite(parsed) && parsed > 0
      ? Math.trunc(parsed)
      : BROWSER_POOL_DEFAULT;
  return Math.min(BROWSER_POOL_MAX, Math.max(BROWSER_POOL_MIN, requested));
}
