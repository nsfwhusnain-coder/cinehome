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
 * Path / query / title tokens for trailers, samples, and previews.
 * Matches the existing Playwright drop list in isValidStreamUrl.
 * Not host blocks — a CDN named "preview*" is left alone.
 */
const PREVIEW_MARKERS = ["trailer", "preview", "sample"] as const;

/**
 * Huge rank / score penalty so poison loses to any non-poison playable source.
 * Applied in scoreSourceEntry and as a hard gate in sortSourcesForDefault.
 */
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

  // Bare PHP redirector wrappers: `…/foo.php?id=…` (not rare legit `.php` paths without query).
  if (path.endsWith(".php") && search.length > 1) return true;
  if (/\.php\?/i.test(lower)) return true;

  return false;
}

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
  return isPoisonStreamUrlAtDepth(url, 0);
}

/**
 * True when path, query, or filename looks like a trailer / sample / preview.
 * HLS `SAMPLE-AES` is stripped first so encrypted playlists are not flagged.
 */
export function isPreviewOrSampleUrl(url: string): boolean {
  return isPreviewOrSampleUrlAtDepth(url, 0);
}

/** Title / label tokens (Official Trailer, Sample, Preview). */
export function isPreviewOrSampleLabel(label: string | undefined): boolean {
  if (!label || typeof label !== "string") return false;
  return hasPreviewOrSampleMarker(label);
}

/**
 * Superset of poison: abuse hosts plus trailer/sample/preview URLs.
 * Must never win auto-default when a clean alternative exists.
 */
export function isNeverAutoDefaultUrl(url: string): boolean {
  return isPoisonStreamUrl(url) || isPreviewOrSampleUrl(url);
}

/** URL or title/label marks this source as last-resort only. */
export function isNeverAutoDefaultSource(
  url: string,
  label?: string
): boolean {
  return isNeverAutoDefaultUrl(url) || isPreviewOrSampleLabel(label);
}

function hasPreviewOrSampleMarker(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().replace(/sample-aes/g, "");
  return PREVIEW_MARKERS.some((marker) => lower.includes(marker));
}

function isPreviewOrSampleUrlAtDepth(url: string, depth: number): boolean {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;

  let parsed: URL | null = null;
  try {
    parsed = new URL(
      raw.startsWith("//") ? `https:${raw}` : raw,
      "http://cinehome.invalid"
    );
  } catch {
    return hasPreviewOrSampleMarker(raw);
  }

  if (depth < 2) {
    const upstream = decodeHlsProxyTarget(parsed);
    if (upstream && isPreviewOrSampleUrlAtDepth(upstream, depth + 1)) return true;
  }

  // Path + query only — do not invent host blocks.
  return hasPreviewOrSampleMarker(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}
