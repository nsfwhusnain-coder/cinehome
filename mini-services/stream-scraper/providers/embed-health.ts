/**
 * Per-embed-host health tracker (in-memory, resets on process restart).
 *
 * Distinct from providers/circuit.ts (fixed ProviderId union for the API
 * providers — vixsrc/vidlink/notorrent/cinepro/cinemaos/playwright as a
 * whole). This tracks individual embed HOSTNAMES pulled from embed-roster
 * buildPrimary/SecondarySourceUrls (vidsrc.me, vidnest.fun, …) so a host that
 * hard-fails (DNS / connection / cert error — a dead domain) across ~2
 * different scrape attempts gets short-circuited on later scrapes instead of
 * burning a Playwright worker slot on every future title.
 *
 * "Failure" here is scoped to hard navigation errors only (see
 * isHardEmbedFailure). A title simply missing from a live, healthy host
 * ("No stream URL found.") must NOT count against it — that is normal and
 * expected even for the best providers.
 *
 * Bounded + self-healing (2026-07-21 roster hygiene):
 * A dead host is skipped FAST (no DNS/connect cost) for DEAD_HOST_COOLDOWN_MS,
 * then exactly one probe is allowed through — same half-open pattern as
 * providers/circuit.ts. A successful probe revives the host immediately; a
 * failed probe just renews the cooldown window. This is never a permanent
 * blacklist (no host is skipped forever) and never unbounded probing (at
 * most one live attempt per host per cooldown window) — no "infinite
 * searching" and no lingering-dead-forever host either.
 */

/** Consecutive hard failures before a host is short-circuited. */
const DEAD_AFTER_FAILURES = 2;

/**
 * How long a dead host stays short-circuited before exactly one probe is
 * allowed through again. Bounded self-heal: long enough that a truly dead
 * host doesn't burn a Playwright worker slot on every title (embeds run per
 * scrape request), short enough that a host which comes back is rediscovered
 * within the same viewing session.
 */
export const DEAD_HOST_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * Safety net: if a probe is let through (isEmbedHostDead returned false) but
 * no outcome is ever recorded for it (crash, uncaught throw before the
 * recordEmbedOutcome call site), release the probe slot after this long so
 * the host cannot get stuck short-circuited forever. Comfortably above the
 * largest per-embed worker budget (PRIMARY_WORKER_BUDGET_MS = 16s).
 */
export const PROBE_STALL_TIMEOUT_MS = 60 * 1000;

/** Consecutive hard failures required before a host is short-circuited. */
export const EMBED_DEAD_AFTER_FAILURES = DEAD_AFTER_FAILURES;

/** Hosts known dead at boot (DNS / permanent outage) — skip without burning PW slots. */
const BOOT_DEAD_HOSTS = ["embed.su", "www.embed.su"] as const;

interface EmbedHealthEntry {
  failures: number;
  dead: boolean;
  /** Timestamp the host most recently flipped dead; drives cooldown expiry. */
  deadAt: number | null;
  /** Timestamp a bounded post-cooldown probe was let through; null when idle. */
  probingSince: number | null;
}

const health = new Map<string, EmbedHealthEntry>();

function freshEntry(dead: boolean, now: number): EmbedHealthEntry {
  return {
    failures: dead ? DEAD_AFTER_FAILURES : 0,
    dead,
    deadAt: dead ? now : null,
    probingSince: null,
  };
}

function seedBootDeadHosts(): void {
  const now = Date.now();
  for (const h of BOOT_DEAD_HOSTS) {
    health.set(h, freshEntry(true, now));
  }
}
seedBootDeadHosts();

function getOrCreate(host: string): EmbedHealthEntry {
  let entry = health.get(host);
  if (!entry) {
    entry = freshEntry(false, Date.now());
    health.set(host, entry);
  }
  return entry;
}

/**
 * True when a tryScrapeUrl error string represents a hard navigation failure
 * (DNS/connection/cert/timeout-to-load — a genuinely dead host), not a soft
 * "page loaded fine but no stream for this title" miss.
 */
export function isHardEmbedFailure(error: string | undefined): boolean {
  if (!error) return false;
  return error.startsWith("Scrape failed:");
}

/**
 * Record one attempt's outcome for a host.
 * ok=true (stream found, or a soft miss/timeout that isn't a hard failure)
 * heals the host back to alive immediately — including a boot-dead host or
 * one that was short-circuited, so nothing stays dead forever once it proves
 * itself alive again.
 * ok=false renews the dead/cooldown window (bounded — never a step further
 * than "skipped until the next cooldown expires").
 */
export function recordEmbedOutcome(host: string, ok: boolean): void {
  if (!host) return;
  const lower = host.toLowerCase();
  const entry = getOrCreate(lower);
  entry.probingSince = null;
  if (ok) {
    entry.failures = 0;
    entry.dead = false;
    entry.deadAt = null;
    return;
  }
  entry.failures += 1;
  if (entry.failures >= DEAD_AFTER_FAILURES) {
    entry.dead = true;
    entry.deadAt = Date.now();
  }
}

/**
 * Whether this host should be skipped right now.
 * Fast path: alive hosts always return false immediately (no bookkeeping
 * beyond the map lookup). Dead hosts stay short-circuited until
 * DEAD_HOST_COOLDOWN_MS elapses, then this call itself claims the single
 * bounded probe slot (returns false exactly once) so the caller can attempt
 * the host again; concurrent callers during that window keep getting `true`.
 * A stalled probe (never resolved via recordEmbedOutcome) auto-releases
 * after PROBE_STALL_TIMEOUT_MS so a crash can never wedge a host dead.
 */
export function isEmbedHostDead(host: string, forceProbe = false): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  const entry = getOrCreate(lower);
  if (!entry.dead) return false;

  const now = Date.now();
  if (forceProbe) {
    if (
      entry.probingSince != null &&
      now - entry.probingSince < PROBE_STALL_TIMEOUT_MS
    ) {
      return true;
    }
    // A user-visible exhausted-roster recovery is stronger evidence than the
    // host cooldown. Claim exactly one half-open slot now; concurrent recovery
    // requests remain short-circuited until this attempt records an outcome.
    entry.probingSince = now;
    return false;
  }
  const cooledDown = entry.deadAt != null && now - entry.deadAt >= DEAD_HOST_COOLDOWN_MS;
  if (!cooledDown) return true;

  if (entry.probingSince != null) {
    if (now - entry.probingSince < PROBE_STALL_TIMEOUT_MS) {
      // A bounded probe is already in flight for this host — stay short-circuited.
      return true;
    }
    // Stale probe (never recorded an outcome) — release the slot and retry below.
  }

  entry.probingSince = now;
  return false;
}

export function getEmbedHealthSnapshot(): Record<string, EmbedHealthEntry> {
  return Object.fromEntries(health.entries());
}

/** Test helper — clears all tracked hosts (re-seeds boot-dead list). */
export function resetEmbedHealth(): void {
  health.clear();
  seedBootDeadHosts();
}
