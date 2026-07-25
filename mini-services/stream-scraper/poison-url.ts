/**
 * Poison / junk stream URLs that must never auto-default when any clean source exists.
 * Pure helpers — no network, no I/O.
 */

/** Hostnames (substring, case-insensitive) that are known abuse / stub CDNs. */
export const POISON_HOST_MARKERS = [
  "cloudflare-terms-of-service-abuse",
  "hostingersite.com",
] as const;

/** Path markers for bare PHP stream redirectors (any host). */
export const POISON_PATH_MARKERS = ["vid1.php"] as const;

/**
 * Huge rank / score penalty so poison loses to any non-poison playable source.
 * Applied in scoreSourceEntry and as a hard gate in sortSourcesForDefault.
 */
export const POISON_SCORE_PENALTY = 500;

/**
 * True when the URL is a known junk / abuse / PHP-wrapper stream.
 * Never auto-default these when any non-poison alternative exists.
 *
 * Patterns (case-insensitive):
 * - hostname contains abuse/hostinger markers
 * - path includes `vid1.php` style redirectors
 * - bare `.php?` query wrappers (hostinger / pulse-class redirectors)
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

  // Bare PHP redirector wrappers: `…/foo.php?id=…` (not rare legit `.php` paths without query).
  if (path.endsWith(".php") && search.length > 1) return true;
  if (/\.php\?/i.test(lower)) return true;

  return false;
}

/**
 * Superset alias: URLs that must never win auto-default when alternatives exist.
 * Currently identical to poison; kept separate so soft demotions can expand later.
 */
export function isNeverAutoDefaultUrl(url: string): boolean {
  return isPoisonStreamUrl(url);
}
