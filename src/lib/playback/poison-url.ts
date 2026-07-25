/**
 * Poison / junk stream URLs — client mirror of mini-services/stream-scraper/poison-url.ts.
 * Keep patterns in sync so dock auto-pick never defaults to abuse hosts when alternatives exist.
 */

/** Hostnames (substring, case-insensitive) that are known abuse / stub CDNs. */
export const POISON_HOST_MARKERS = [
  "cloudflare-terms-of-service-abuse",
  "hostingersite.com",
] as const;

/** Path markers for bare PHP stream redirectors (any host). */
export const POISON_PATH_MARKERS = ["vid1.php"] as const;

/** Score penalty so poison loses to any non-poison playable source in client ranking. */
export const POISON_SCORE_PENALTY = 500;

/**
 * True when the URL is a known junk / abuse / PHP-wrapper stream.
 * Never auto-default these when any non-poison alternative exists.
 */
export function isPoisonStreamUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase().trim();
  if (!lower) return false;

  let host = "";
  let path = "";
  let search = "";
  try {
    const u = new URL(lower.startsWith("//") ? `https:${lower}` : lower);
    host = u.hostname;
    path = u.pathname;
    search = u.search;
  } catch {
    /* fall through to substring matches */
  }

  for (const marker of POISON_HOST_MARKERS) {
    if (host.includes(marker) || lower.includes(marker)) return true;
  }

  for (const marker of POISON_PATH_MARKERS) {
    if (path.includes(marker) || lower.includes(marker)) return true;
  }

  if (path.endsWith(".php") && search.length > 1) return true;
  if (/\.php\?/i.test(lower)) return true;

  return false;
}

/** Superset alias: must never win auto-default when alternatives exist. */
export function isNeverAutoDefaultUrl(url: string): boolean {
  return isPoisonStreamUrl(url);
}
