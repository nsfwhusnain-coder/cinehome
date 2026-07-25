/**
 * In-memory login/register rate limiter (KD21, hardened KD-sec fix #7).
 * Primary key: username (case-insensitive). Secondary soft key: IP.
 * Suitable for a single-container household deploy — resets on process restart.
 *
 * Login lockout (per username) is only incremented by failed credential checks.
 * Register "name taken" (409) only bumps the soft IP counter so it cannot lock
 * a known account out of login.
 *
 * ESCALATING LOCKOUT (KD-sec fix #7): a flat 5-attempts/15-minutes window lets
 * a patient attacker get ~480 guesses/day indefinitely against a 4-10 digit
 * PIN — the PIN is the only factor protecting the admin account once open
 * registration is closed. Each time a username's failure count actually
 * reaches the cap and the attacker comes back and fails again, the lockout
 * window for that username doubles (15m → 30m → 1h → 2h → ... capped at
 * 24h), so persistent brute-forcing gets exponentially more expensive. This
 * escalation is remembered for up to `LOCKOUT_MEMORY_MS` (24h) of inactivity
 * — a real owner who mistypes a PIN, or even one who gets locked out once and
 * comes back later, is never locked out *permanently*; a full day with no
 * further attempts forgives the escalation and normal 15-minute lockouts
 * resume. A successful login clears everything immediately regardless.
 * The soft per-IP counter is intentionally NOT escalated — it exists only to
 * blunt unauthenticated-username spray attempts without ever locking out an
 * entire household NAT for an extended period.
 */

const MAX_USERNAME_FAILURES = 5;
const MAX_IP_FAILURES = 30; // soft secondary — avoid locking whole household on one NAT
const BASE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes — base counting/lockout window
/**
 * Ceiling on how long a single lockout can last, AND how long an expired
 * bucket's escalation state ("strikes") is remembered before being forgiven.
 * Using one constant for both keeps the "never permanent" guarantee obvious:
 * nothing about a username's failure history outlives this window once
 * attempts stop.
 */
const LOCKOUT_MEMORY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STRIKES = 6; // 15m * 2^6 = 16h; the next strike clamps to the 24h ceiling anyway
const MAX_MAP_ENTRIES = 2_000;
const PRUNE_INTERVAL_MS = 60_000;

export const LOGIN_RATE_LIMIT_MESSAGE =
  "Too many failed attempts. Try again in a few minutes.";

interface AttemptBucket {
  failures: number;
  windowStartedAt: number;
  /** Active lockout/counting window for this bucket. Flat for IP; grows per username strike. */
  windowMs: number;
  /** Consecutive escalations for this username. Always 0 for IP buckets. */
  strikes: number;
}

const byUsername = new Map<string, AttemptBucket>();
const byIp = new Map<string, AttemptBucket>();

let lastPruneAt = 0;

function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** Is the bucket's CURRENT counting/lockout window over? (Does not mutate.) */
function isExpired(bucket: AttemptBucket, now: number): boolean {
  return now - bucket.windowStartedAt >= bucket.windowMs;
}

/**
 * Read-only bucket lookup. Never mutates the map — in particular it must NOT
 * delete an expired bucket, because `getOrCreateUsernameBucket` still needs
 * to see it (via the map, not this function) to decide whether to escalate
 * the next lockout. Cleanup is entirely `pruneMap`'s job.
 */
function peekBucket(
  map: Map<string, AttemptBucket>,
  key: string,
  now: number
): AttemptBucket | null {
  const existing = map.get(key);
  if (!existing || isExpired(existing, now)) return null;
  return existing;
}

/** Exponential backoff for repeated lockouts: 15m, 30m, 1h, 2h, ... capped at 24h. */
function lockoutWindowForStrikes(strikes: number): number {
  const capped = Math.min(strikes, MAX_STRIKES);
  return Math.min(BASE_WINDOW_MS * 2 ** capped, LOCKOUT_MEMORY_MS);
}

/**
 * Insert-or-refresh the username bucket, used only when recording a failure.
 * Escalates the lockout window when the bucket being replaced had actually
 * reached the failure cap (a real lockout occurred) and the attacker is back
 * within `LOCKOUT_MEMORY_MS` — as opposed to a legitimate user who mistyped a
 * PIN a couple of times, never got locked out, and tried again later.
 */
function getOrCreateUsernameBucket(key: string, now: number): AttemptBucket {
  const existing = byUsername.get(key);
  if (existing && !isExpired(existing, now)) {
    return existing;
  }

  let strikes = 0;
  if (existing) {
    const wasLockedOut = existing.failures >= MAX_USERNAME_FAILURES;
    const withinMemory = now - existing.windowStartedAt < LOCKOUT_MEMORY_MS;
    if (wasLockedOut && withinMemory) {
      strikes = existing.strikes + 1;
    }
  }

  const fresh: AttemptBucket = {
    failures: 0,
    windowStartedAt: now,
    windowMs: lockoutWindowForStrikes(strikes),
    strikes,
  };
  byUsername.set(key, fresh);
  return fresh;
}

/** Insert-or-refresh the (non-escalating) IP bucket. */
function getOrCreateIpBucket(key: string, now: number): AttemptBucket {
  const existing = byIp.get(key);
  if (existing && !isExpired(existing, now)) {
    return existing;
  }
  const fresh: AttemptBucket = {
    failures: 0,
    windowStartedAt: now,
    windowMs: BASE_WINDOW_MS,
    strikes: 0,
  };
  byIp.set(key, fresh);
  return fresh;
}

function remainingMs(bucket: AttemptBucket, now: number): number {
  return Math.max(0, bucket.windowMs - (now - bucket.windowStartedAt));
}

/**
 * Sweeps a map of expired/spent buckets. `hardTtlMs` decides how long a
 * bucket survives in the map past its own `windowStartedAt` — for username
 * buckets this is the long `LOCKOUT_MEMORY_MS` (so escalation state outlives
 * a single short lockout window), for IP buckets it's just that bucket's own
 * flat window (nothing to remember there).
 */
function pruneMap(
  map: Map<string, AttemptBucket>,
  now: number,
  hardTtlMs: (bucket: AttemptBucket) => number
): void {
  for (const [key, bucket] of map) {
    if (now - bucket.windowStartedAt >= hardTtlMs(bucket) || bucket.failures <= 0) {
      map.delete(key);
    }
  }
  if (map.size <= MAX_MAP_ENTRIES) return;

  // Drop oldest windows first when over cap (probe / abuse safety).
  const entries = Array.from(map.entries()).sort(
    (a, b) => a[1].windowStartedAt - b[1].windowStartedAt
  );
  const toDrop = map.size - MAX_MAP_ENTRIES;
  for (let i = 0; i < toDrop; i++) {
    const key = entries[i]?.[0];
    if (key !== undefined) map.delete(key);
  }
}

function maybePrune(now: number): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruneMap(byUsername, now, () => LOCKOUT_MEMORY_MS);
  pruneMap(byIp, now, (bucket) => bucket.windowMs);
}

export interface RateLimitResult {
  allowed: boolean;
  message?: string;
  retryAfterMs?: number;
}

/** Returns whether a login/register attempt may proceed for this username (+ soft IP). */
export function checkAuthRateLimit(
  username: string,
  ip?: string | null
): RateLimitResult {
  const now = Date.now();
  maybePrune(now);

  const userKey = normalizeUsername(username);
  if (!userKey) {
    return { allowed: true };
  }

  const userBucket = peekBucket(byUsername, userKey, now);
  if (userBucket && userBucket.failures >= MAX_USERNAME_FAILURES) {
    return {
      allowed: false,
      message: LOGIN_RATE_LIMIT_MESSAGE,
      retryAfterMs: remainingMs(userBucket, now),
    };
  }

  const ipKey = normalizeIp(ip);
  if (ipKey) {
    const ipBucket = peekBucket(byIp, ipKey, now);
    if (ipBucket && ipBucket.failures >= MAX_IP_FAILURES) {
      return {
        allowed: false,
        message: LOGIN_RATE_LIMIT_MESSAGE,
        retryAfterMs: remainingMs(ipBucket, now),
      };
    }
  }

  return { allowed: true };
}

/**
 * Record a failed credential check (bad PIN / unknown user on login).
 * Increments both username lockout and soft IP counters.
 */
export function recordAuthFailure(username: string, ip?: string | null): void {
  const now = Date.now();
  maybePrune(now);

  const userKey = normalizeUsername(username);
  if (userKey) {
    const bucket = getOrCreateUsernameBucket(userKey, now);
    bucket.failures += 1;
  }

  recordIpAuthFailure(ip, now);
}

/**
 * Soft IP-only failure (e.g. register "name taken").
 * Does NOT touch per-username login lockout counters.
 */
export function recordIpAuthFailure(
  ip?: string | null,
  now: number = Date.now()
): void {
  maybePrune(now);
  const ipKey = normalizeIp(ip);
  if (!ipKey) return;
  const bucket = getOrCreateIpBucket(ipKey, now);
  bucket.failures += 1;
}

/**
 * Clear per-username lockout after a successful login (or successful register).
 * Also resets escalation strikes — a successful login proves account
 * ownership, so past failed attempts are forgiven immediately.
 * Does not wipe the soft IP bucket — household NAT must not reset shared IP
 * counters when any single user authenticates successfully.
 */
export function clearAuthFailures(username: string, _ip?: string | null): void {
  const userKey = normalizeUsername(username);
  if (userKey) byUsername.delete(userKey);
}

/** Extract client IP from common proxy headers (soft secondary signal only). */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return normalizeIp(forwarded);
  const realIp = headers.get("x-real-ip");
  if (realIp) return normalizeIp(realIp);
  return null;
}
