/** Mid-play remux 404/502 is a dead packer, not a bad source. Restart it. */
export const REMUX_RESTART_COOLDOWN_MS = 12_000;
export const REMUX_RESTART_MAX_PER_SOURCE = 8;
export const REMUX_RESTART_HTTP_CODES = new Set([404, 410, 429, 502, 503]);

export function shouldRestartRemux(options: {
  remux: boolean;
  everPlayed: boolean;
  httpCode: number;
  restartCount: number;
  lastRestartAtMs: number;
  nowMs: number;
}): boolean {
  if (!options.remux || !options.everPlayed) return false;
  if (!REMUX_RESTART_HTTP_CODES.has(options.httpCode)) return false;
  if (options.restartCount >= REMUX_RESTART_MAX_PER_SOURCE) return false;
  if (options.nowMs - options.lastRestartAtMs < REMUX_RESTART_COOLDOWN_MS) {
    return false;
  }
  return true;
}
