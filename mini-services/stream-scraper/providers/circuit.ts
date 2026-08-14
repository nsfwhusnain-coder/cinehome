/**
 * In-memory per-provider circuit breakers (reset on process restart).
 * Thresholds from CINEHOME-OVERHAUL-DESIGN §8.3.
 */

export type CircuitState = "closed" | "open" | "half_open";

export type ProviderId =
  | "vixsrc"
  | "vidlink"
  | "notorrent"
  | "playwright"
  | "cinepro"
  | "cinemaos"
  | "videasy"
  | "vidrock";

/** Window: last N attempts or WINDOW_MS, whichever trims first. */
const WINDOW_MAX_SAMPLES = 20;
const WINDOW_MS = 10 * 60 * 1000;
const MIN_SAMPLES = 5;
const ERROR_RATE_THRESHOLD = 0.5;
/** Open after this many consecutive failures (in addition to error-rate window). */
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
/** Open duration before a single half-open probe is allowed (was 15m — too sticky). */
const OPEN_DURATION_MS = 60 * 1000;

export interface CircuitSnapshot {
  state: CircuitState;
  enabled: boolean;
  samples: number;
  errors: number;
  errorRate: number;
  openedAt: number | null;
  openUntil: number | null;
  lastMs: number | null;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

interface Attempt {
  at: number;
  ok: boolean;
}

interface CircuitInternal {
  attempts: Attempt[];
  openedAt: number | null;
  halfOpenInFlight: boolean;
  consecutiveFailures: number;
  lastMs: number | null;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

const ENV_KILL_SWITCH: Record<ProviderId, string | null> = {
  vixsrc: "PROVIDER_VIXSRC",
  vidlink: "PROVIDER_VIDLINK",
  notorrent: "PROVIDER_NOTORRENT",
  playwright: "PROVIDER_PLAYWRIGHT",
  cinepro: "PROVIDER_CINEPRO",
  cinemaos: "PROVIDER_CINEMAOS",
  videasy: "PROVIDER_VIDEASY",
  vidrock: "PROVIDER_VIDROCK",
};

const circuits = new Map<ProviderId, CircuitInternal>();

function getOrCreate(id: ProviderId): CircuitInternal {
  let c = circuits.get(id);
  if (!c) {
    c = {
      attempts: [],
      openedAt: null,
      halfOpenInFlight: false,
      consecutiveFailures: 0,
      lastMs: null,
      lastAt: null,
      lastOk: null,
      lastError: null,
    };
    circuits.set(id, c);
  }
  return c;
}

/**
 * Env kill switch: unset/empty = enabled; `0` / `false` / `off` = disabled.
 * CinePro is enabled when `CINEPRO_URL` is configured (it is a separate HTTP
 * fan-out and does not touch the Playwright pool). Kill with `PROVIDER_CINEPRO=0`.
 *
 * Also enabled by:
 * 1. `PROVIDER_CINEPRO=1` (or true/on/yes) — permanent opt-in
 * 2. `CINEPRO_EVAL_UNTIL=<unix_ms_or_ISO>` — 48h evaluation window
 */
export function isCineproUrlConfigured(): boolean {
  const raw = process.env.CINEPRO_URL?.trim();
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}

export function isProviderEnabled(id: ProviderId): boolean {
  const envKey = ENV_KILL_SWITCH[id];
  if (!envKey) return true;
  const raw = process.env[envKey];
  if (id === "cinepro") {
    if (raw !== undefined && raw !== "") {
      const v = raw.trim().toLowerCase();
      if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
      if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    }
    if (isCineproUrlConfigured()) return true;
    return isCineproEvalWindowOpen();
  }
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Parse CINEPRO_EVAL_UNTIL as unix ms or ISO-8601. Open while now < until.
 */
export function isCineproEvalWindowOpen(nowMs: number = Date.now()): boolean {
  const raw = process.env.CINEPRO_EVAL_UNTIL?.trim();
  if (!raw) return false;
  let until = Number(raw);
  if (!Number.isFinite(until) || until <= 0) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return false;
    until = parsed;
  }
  return nowMs < until;
}

/** Helper for ops: set eval window to now + 48 hours (returns ISO string for .env). */
export function cineproEvalUntilIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + 48 * 60 * 60 * 1000).toISOString();
}

function pruneAttempts(c: CircuitInternal, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (c.attempts.length > 0 && c.attempts[0]!.at < cutoff) {
    c.attempts.shift();
  }
  while (c.attempts.length > WINDOW_MAX_SAMPLES) {
    c.attempts.shift();
  }
}

function sampleStats(c: CircuitInternal, now: number): { samples: number; errors: number; errorRate: number } {
  pruneAttempts(c, now);
  const samples = c.attempts.length;
  const errors = c.attempts.filter((a) => !a.ok).length;
  const errorRate = samples > 0 ? errors / samples : 0;
  return { samples, errors, errorRate };
}

function computeState(c: CircuitInternal, now: number): CircuitState {
  if (c.openedAt != null) {
    if (now - c.openedAt >= OPEN_DURATION_MS) {
      return "half_open";
    }
    return "open";
  }
  return "closed";
}

function maybeOpen(c: CircuitInternal, now: number): void {
  const { samples, errorRate } = sampleStats(c, now);
  if (samples >= MIN_SAMPLES && errorRate >= ERROR_RATE_THRESHOLD) {
    c.openedAt = now;
    c.halfOpenInFlight = false;
  }
}

/**
 * Whether a provider call should proceed.
 * Open circuits block until OPEN_DURATION_MS, then allow one half-open probe.
 */
export function canAttempt(id: ProviderId): boolean {
  if (!isProviderEnabled(id)) return false;
  const c = getOrCreate(id);
  const now = Date.now();
  const state = computeState(c, now);

  if (state === "closed") return true;

  if (state === "open") return false;

  // half_open: single probe
  if (c.halfOpenInFlight) return false;
  c.halfOpenInFlight = true;
  return true;
}

export function recordSuccess(id: ProviderId, durationMs: number): void {
  const c = getOrCreate(id);
  const now = Date.now();
  c.attempts.push({ at: now, ok: true });
  pruneAttempts(c, now);
  c.lastMs = durationMs;
  c.lastAt = now;
  c.lastOk = true;
  c.lastError = null;
  c.openedAt = null;
  c.halfOpenInFlight = false;
  c.consecutiveFailures = 0;
}

export function recordFailure(id: ProviderId, durationMs: number, error?: string): void {
  const c = getOrCreate(id);
  const now = Date.now();
  c.attempts.push({ at: now, ok: false });
  pruneAttempts(c, now);
  c.lastMs = durationMs;
  c.lastAt = now;
  c.lastOk = false;
  c.lastError = error ?? "failed";
  c.halfOpenInFlight = false;
  c.consecutiveFailures = (c.consecutiveFailures ?? 0) + 1;

  const state = computeState(c, now);
  if (state === "half_open" || c.openedAt != null) {
    // Probe failed or already open — (re)open fully
    c.openedAt = now;
    return;
  }
  if (c.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    c.openedAt = now;
    return;
  }
  maybeOpen(c, now);
}

/**
 * Run `fn` behind the circuit for `id`.
 * Returns null when disabled, open, or the call fails / is classified as failure.
 */
export async function withCircuit<T>(
  id: ProviderId,
  fn: () => Promise<T>,
  options?: {
    /**
     * Default: non-null success. Empty arrays are title misses (success), not outages.
     * Callers should throw on outer timeout (null from withTimeout) so failures open the circuit.
     */
    isSuccess?: (value: T) => boolean;
  }
): Promise<T | null> {
  if (!canAttempt(id)) return null;

  const started = Date.now();
  try {
    const value = await fn();
    // Title miss (`[]`) is not a provider outage. Only null/undefined default to failure
    // unless isSuccess overrides (all scraper providers pass isSuccess: r != null).
    const ok = options?.isSuccess ? options.isSuccess(value) : value != null;

    const ms = Date.now() - started;
    if (ok) {
      recordSuccess(id, ms);
      return value;
    }
    recordFailure(id, ms, "empty_result");
    return null;
  } catch (e: unknown) {
    const ms = Date.now() - started;
    const message = e instanceof Error ? e.message : String(e);
    recordFailure(id, ms, message);
    return null;
  }
}

export function getCircuitSnapshot(id: ProviderId): CircuitSnapshot {
  const c = getOrCreate(id);
  const now = Date.now();
  const { samples, errors, errorRate } = sampleStats(c, now);
  const state = computeState(c, now);
  const enabled = isProviderEnabled(id);
  return {
    state: enabled ? state : "closed",
    enabled,
    samples,
    errors,
    errorRate: Math.round(errorRate * 1000) / 1000,
    openedAt: c.openedAt,
    openUntil: c.openedAt != null ? c.openedAt + OPEN_DURATION_MS : null,
    lastMs: c.lastMs,
    lastAt: c.lastAt,
    lastOk: c.lastOk,
    lastError: c.lastError,
  };
}

export function getAllCircuitSnapshots(): Record<ProviderId, CircuitSnapshot> {
  const ids: ProviderId[] = [
    "vixsrc",
    "vidlink",
    "notorrent",
    "playwright",
    "cinepro",
    "cinemaos",
    "videasy",
    "vidrock",
  ];
  const out = {} as Record<ProviderId, CircuitSnapshot>;
  for (const id of ids) {
    out[id] = getCircuitSnapshot(id);
  }
  return out;
}

/** Test helper: force-open a circuit (e.g. simulated enc-dec outage). */
export function forceOpenCircuit(id: ProviderId): void {
  const c = getOrCreate(id);
  c.openedAt = Date.now();
  c.halfOpenInFlight = false;
}
