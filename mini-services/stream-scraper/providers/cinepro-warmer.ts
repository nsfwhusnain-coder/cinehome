/**
 * CinePro cache-warmer — pre-resolves popular titles against cinepro-core so
 * its internal cache is hot before a user clicks Play.
 *
 * WHY: cinepro-core (the OMSS multi-provider fan-out) resolves its 14+ upstream
 * providers *once* per title, then serves that result from cache in ~1-3ms
 * forever after. The cold first-build takes 10-20s (upstream VidRock/Peachify/
 * VidNest are slow), which blows CineHome's fast/full CinePro budgets (8s/12s)
 * and made the CinePro circuit record an 87% failure rate on the eval harness.
 *
 * The warmer closes that gap: it walks a seed list of popular + browse-staple
 * titles with a generous per-title budget (20s — long enough for cinepro-core's
 * cold build), so by the time a user lands on a title, cinepro-core already has
 * it cached and the CinePro arm returns 1-7 sources in milliseconds.
 *
 * Contract:
 * - Fire-and-forget. Never blocks /scrape or /health.
 * - Bounded concurrency (titles resolved in small parallel batches).
 * - All failures swallowed + logged — a warmer failure must NEVER affect playback.
 * - Gated: only runs when cinepro is configured AND enabled.
 *   Kill switch: CINEPRO_WARMER_ENABLED=0 (or false/off/no).
 */

import { resolveCinepro } from "./cinepro";

/** Per-title budget — long enough for cinepro-core's cold 14-provider build. */
const WARMER_PER_TITLE_TIMEOUT_MS = 20_000;
/** Parallel titles in flight. Low to avoid hammering cinepro-core's pool. */
const WARMER_CONCURRENCY = 2;
/** Delay after boot before the first warm pass (let browsers + first scrape win). */
const WARMER_BOOT_DELAY_MS = 15_000;
/** Re-warm cadence — keeps cinepro-core's cache alive across long sessions. */
const WARMER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

interface WarmTitle {
  name: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
}

/**
 * Seed list — popular + browse-staple titles users are most likely to click.
 * Mix of blockbuster movies and top TV pilots (the most-clicked entry points).
 * Keep modest (≤ ~24) so a full warm pass completes well under WARMER_INTERVAL_MS.
 */
const SEED_TITLES: WarmTitle[] = [
  { name: "Fight Club", tmdbId: 550, mediaType: "movie" },
  { name: "Inception", tmdbId: 27205, mediaType: "movie" },
  { name: "Interstellar", tmdbId: 157336, mediaType: "movie" },
  { name: "The Dark Knight", tmdbId: 155, mediaType: "movie" },
  { name: "Dune Part Two", tmdbId: 693134, mediaType: "movie" },
  { name: "Dune", tmdbId: 438631, mediaType: "movie" },
  { name: "Oppenheimer", tmdbId: 872585, mediaType: "movie" },
  { name: "The Batman", tmdbId: 414906, mediaType: "movie" },
  { name: "Joker", tmdbId: 475557, mediaType: "movie" },
  { name: "Top Gun Maverick", tmdbId: 361743, mediaType: "movie" },
  { name: "Spider-Man No Way Home", tmdbId: 634649, mediaType: "movie" },
  { name: "Avatar Way of Water", tmdbId: 76600, mediaType: "movie" },
  { name: "Breaking Bad S1E1", tmdbId: 1396, mediaType: "tv", season: 1, episode: 1 },
  { name: "The Witcher S1E1", tmdbId: 71912, mediaType: "tv", season: 1, episode: 1 },
  { name: "Stranger Things S1E1", tmdbId: 66732, mediaType: "tv", season: 1, episode: 1 },
  { name: "The Office S1E1", tmdbId: 2316, mediaType: "tv", season: 1, episode: 1 },
  { name: "Game of Thrones S1E1", tmdbId: 1399, mediaType: "tv", season: 1, episode: 1 },
  { name: "House of the Dragon S1E1", tmdbId: 94997, mediaType: "tv", season: 1, episode: 1 },
  { name: "The Last of Us S1E1", tmdbId: 100088, mediaType: "tv", season: 1, episode: 1 },
  { name: "Wednesday S1E1", tmdbId: 119051, mediaType: "tv", season: 1, episode: 1 },
];

let warming = false;

function warmerEnabled(): boolean {
  const raw = process.env.CINEPRO_WARMER_ENABLED?.trim().toLowerCase();
  // Default ON (when unset/empty). Explicit opt-out only.
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function log(msg: string): void {
  // Reuse the scraper's log convention so it shows in container logs.
  console.log(`[cinepro-warmer] ${msg}`);
}

async function warmOne(t: WarmTitle): Promise<void> {
  const started = Date.now();
  try {
    const sources = await resolveCinepro(t.tmdbId, t.mediaType, t.season, t.episode, {
      timeoutMs: WARMER_PER_TITLE_TIMEOUT_MS,
    });
    const elapsed = Date.now() - started;
    log(`warmed ${t.name} → ${sources.length} source(s) in ${elapsed}ms`);
  } catch (e) {
    // Swallow — warmer failure must never affect playback or the circuit.
    const msg = e instanceof Error ? e.message : String(e);
    const elapsed = Date.now() - started;
    log(`warm failed ${t.name} (${elapsed}ms): ${msg}`);
  }
}

/** Run one full warm pass over the seed list with bounded concurrency. */
async function warmPass(): Promise<void> {
  if (warming) return;
  warming = true;
  try {
    const queue = [...SEED_TITLES];
    const passStart = Date.now();
    let done = 0;

    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const t = queue.shift();
        if (!t) break;
        await warmOne(t);
        done++;
      }
    }

    const workers = Array.from(
      { length: Math.min(WARMER_CONCURRENCY, SEED_TITLES.length) },
      () => worker()
    );
    await Promise.all(workers);
    log(`pass complete: ${done}/${SEED_TITLES.length} in ${Date.now() - passStart}ms`);
  } finally {
    warming = false;
  }
}

/**
 * Start the warmer. Fire-and-forget: schedules a delayed first pass, then a
 * recurring pass every WARMER_INTERVAL_MS. Returns immediately.
 */
export function startCineproWarmer(opts: {
  isCineproConfigured: () => boolean;
  isCineproEnabled: () => boolean;
}): void {
  if (!warmerEnabled()) {
    log("disabled by CINEPRO_WARMER_ENABLED");
    return;
  }
  if (!opts.isCineproConfigured()) {
    log("skipped — CINEPRO_URL not configured");
    return;
  }
  if (!opts.isCineproEnabled()) {
    log("skipped — CinePro provider not enabled (set PROVIDER_CINEPRO=1)");
    return;
  }

  log(
    `starting: seed=${SEED_TITLES.length} concurrency=${WARMER_CONCURRENCY} bootDelay=${WARMER_BOOT_DELAY_MS}ms interval=${WARMER_INTERVAL_MS}ms`
  );

  // First pass after boot delay (browsers + first user scrape take priority).
  setTimeout(() => {
    warmPass().catch((e) => log(`pass crashed: ${e}`));
    // Recurring re-warm to keep cinepro-core's cache alive.
    setInterval(() => {
      warmPass().catch((e) => log(`pass crashed: ${e}`));
    }, WARMER_INTERVAL_MS);
  }, WARMER_BOOT_DELAY_MS);
}
