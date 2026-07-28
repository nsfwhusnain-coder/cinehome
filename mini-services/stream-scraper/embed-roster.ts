/**
 * Playwright embed roster — primary + secondary waves (Phase 3).
 *
 * Primary (always when PW runs): Vidking, the sole currently productive host.
 * Secondary (only when verified/non-poison sources < 2 after primary+API):
 *   2embed + multiembed + one extra vidsrc mirror.
 *
 * Dropped from active roster (API paths exist / historically dead fan-out):
 *   player.videasy.net, vidlink.pro embed, smashy, autoembed, moviesapi, embed.su,
 *   multi-vidsrc same-scrape (.to + .me + .rip + .cc all at once).
 *
 * Roster hygiene (2026-07-21): VidFast (vidfast.pro) and VidsrcTO (vidsrc.to)
 * dropped from the primary wave — 24h of production logs showed 8/8 persistent
 * misses each (never once returned a stream). See
 * docs/research/fmhy-15plus-source-map.md.
 *
 * Roster hygiene (2026-07-26): VidNest missed 8/8 measured production
 * enrichments and then 3/3 isolated provider-only captures (Fight Club,
 * Oppenheimer, The Office). Each busy page consumed a Chromium worker for up
 * to 16 seconds. It was removed from the primary wave; API providers already
 * supply the fallback roster when Vidking misses.
 */

export interface EmbedSourceSpec {
  url: string;
  waitUntil: "domcontentloaded" | "networkidle";
  /** Primary embeds get longer capture budgets. */
  priority: "primary" | "secondary";
  /** page.goto timeout (ms). */
  gotoTimeoutMs: number;
  /** Post-goto capture wait for stream requests (ms). */
  captureWaitMs: number;
  /** Hard wall-clock budget for the whole embed attempt (ms). */
  workerBudgetMs: number;
}

/** Max hosts in the primary Playwright wave. */
export const PRIMARY_MAX = 1;
/** Max hosts in the secondary Playwright wave. */
export const SECONDARY_MAX = 3;
/**
 * Skip secondary wave once this many verified + non-poison sources exist
 * (API enrich + primary embeds combined).
 */
export const VERIFIED_MIN_SKIP_SECONDARY = 2;

/**
 * Primary embed page.goto timeout. A dead Vidking arm must leave half of the
 * shared wall for an independent secondary provider.
 */
export const PRIMARY_GOTO_TIMEOUT_MS = 11_000;
/** Primary post-goto capture window (early-exit often finishes 1.5–8s). */
export const PRIMARY_CAPTURE_WAIT_MS = 8_000;
/** Primary per-embed hard wall; deliberately bounded below the 20s wave wall. */
export const PRIMARY_WORKER_BUDGET_MS = 12_000;

/** Secondary embeds — shorter so they fit residual PW wall. */
export const SECONDARY_GOTO_TIMEOUT_MS = 8_000;
export const SECONDARY_CAPTURE_WAIT_MS = 5_000;
export const SECONDARY_WORKER_BUDGET_MS = 10_000;

/**
 * Overall Playwright hard wall across both waves (primary + optional secondary).
 * Phase 3 intercept: 28s → 20s (network early-exit shrinks median per-embed).
 */
export const PW_WAIT_MS = 20_000;

/**
 * Absolute cap for background enrich (APIs + PW). Phase 3 intercept: 38s → 28s.
 * Must stay ≥ PW_WAIT_MS + small API headroom.
 */
export const ENRICH_HARD_TIMEOUT_MS = 28_000;

/** Minimum residual PW budget before starting a secondary wave. */
export const SECONDARY_MIN_REMAINING_MS = 6_000;

const THEME = "E8B23A";

const primaryBudgets: Omit<EmbedSourceSpec, "url"> = {
  waitUntil: "domcontentloaded",
  priority: "primary",
  gotoTimeoutMs: PRIMARY_GOTO_TIMEOUT_MS,
  captureWaitMs: PRIMARY_CAPTURE_WAIT_MS,
  workerBudgetMs: PRIMARY_WORKER_BUDGET_MS,
};

const secondaryBudgets: Omit<EmbedSourceSpec, "url"> = {
  waitUntil: "domcontentloaded",
  priority: "secondary",
  gotoTimeoutMs: SECONDARY_GOTO_TIMEOUT_MS,
  captureWaitMs: SECONDARY_CAPTURE_WAIT_MS,
  workerBudgetMs: SECONDARY_WORKER_BUDGET_MS,
};

/**
 * Primary wave — always when Playwright runs.
 * Live production measurement (2026-07-26): Vidking 2/8, VidNest 0/8.
 * VidFast (vidfast.pro) and VidsrcTO (vidsrc.to) were dropped 2026-07-21 —
 * 8/8 persistent misses each over 24h of production logs (see file header).
 */
export function buildPrimarySourceUrls(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): EmbedSourceSpec[] {
  if (mediaType === "tv" && season != null && episode != null) {
    return [
      {
        url: `https://www.vidking.net/embed/tv/${tmdbId}/${season}/${episode}?color=${THEME}&autoPlay=true`,
        ...primaryBudgets,
      },
    ].slice(0, PRIMARY_MAX);
  }
  return [
    {
      url: `https://www.vidking.net/embed/movie/${tmdbId}?color=${THEME}&autoPlay=true`,
      ...primaryBudgets,
    },
  ].slice(0, PRIMARY_MAX);
}

/**
 * Secondary wave — only when verified/non-poison count is still thin.
 * 2embed + multiembed + one vidsrc mirror (vidsrc.me — the .to mirror was
 * dropped from primary as a persistent dead host; not duplicated here).
 */
export function buildSecondarySourceUrls(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): EmbedSourceSpec[] {
  if (mediaType === "tv" && season != null && episode != null) {
    return [
      {
        url: `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`,
        ...secondaryBudgets,
      },
      {
        url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
        ...secondaryBudgets,
      },
      {
        url: `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`,
        ...secondaryBudgets,
      },
    ].slice(0, SECONDARY_MAX);
  }
  return [
    {
      url: `https://www.2embed.cc/embed/${tmdbId}`,
      ...secondaryBudgets,
    },
    {
      url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`,
      ...secondaryBudgets,
    },
    {
      url: `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`,
      ...secondaryBudgets,
    },
  ].slice(0, SECONDARY_MAX);
}

/**
 * Full roster (primary + secondary). Used by tests and any caller that wants
 * the complete list without wave branching.
 */
export function buildSourceUrls(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number
): EmbedSourceSpec[] {
  return [
    ...buildPrimarySourceUrls(tmdbId, mediaType, season, episode),
    ...buildSecondarySourceUrls(tmdbId, mediaType, season, episode),
  ];
}

/** Distinct hostname (lowercase) from an embed URL, or empty on parse failure. */
export function embedHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when hostname is a vidsrc* mirror (vidsrc.to / .me / .rip / .cc / …). */
export function isVidsrcHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "vidsrc.to" || h.endsWith(".vidsrc.to") || h.includes("vidsrc");
}

/**
 * Count distinct vidsrc* hosts across a list of embed specs.
 * Policy: at most 2 across primary+secondary full roster.
 */
export function countDistinctVidsrcHosts(specs: EmbedSourceSpec[]): number {
  const hosts = new Set<string>();
  for (const s of specs) {
    const host = embedHostFromUrl(s.url);
    if (host && isVidsrcHost(host)) hosts.add(host);
  }
  return hosts.size;
}

export interface VerifiedSourceLike {
  url: string;
  verified?: boolean;
}

/**
 * Count sources that are verified (or unflagged) and not poison.
 * Secondary wave runs only when this is &lt; VERIFIED_MIN_SKIP_SECONDARY.
 */
export function countVerifiedNonPoison(
  sources: VerifiedSourceLike[],
  isPoison: (url: string) => boolean
): number {
  return sources.filter(
    (s) => s.verified !== false && !isPoison(s.url)
  ).length;
}
