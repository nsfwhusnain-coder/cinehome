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

function decodeHlsProxyTarget(url: URL): string | null {
  if (!url.pathname.startsWith("/api/hls/")) return null;
  const encoded = url.searchParams.get("u");
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function isPoisonStreamUrlAtDepth(url: string, depth: number): boolean {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();

  let parsed: URL | null = null;
  let host = "";
  let path = "";
  let search = "";
  try {
    parsed = new URL(
      raw.startsWith("//") ? `https:${raw}` : raw,
      "http://cinehome.invalid"
    );
    host = parsed.hostname;
    path = parsed.pathname;
    search = parsed.search;
  } catch {
    /* fall through to substring matches */
  }

  if (parsed && depth < 2) {
    const upstream = decodeHlsProxyTarget(parsed);
    if (upstream && isPoisonStreamUrlAtDepth(upstream, depth + 1)) return true;
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

/**
 * True when the URL is a known junk / abuse / PHP-wrapper stream.
 * Never auto-default these when any non-poison alternative exists.
 */
export function isPoisonStreamUrl(url: string): boolean {
  return isPoisonStreamUrlAtDepth(url, 0);
}

/** Superset alias: must never win auto-default when alternatives exist. */
export function isNeverAutoDefaultUrl(url: string): boolean {
  return isPoisonStreamUrl(url);
}
