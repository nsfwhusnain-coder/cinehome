const TRANSCODER_URL =
  process.env.TRANSCODER_INTERNAL_URL || "http://127.0.0.1:3040";
const REMUX_HEALTH_TIMEOUT_MS = 400;

interface TranscoderHealth {
  activeRemuxes?: number;
  startingRemuxes?: number;
  remuxMaxConcurrent?: number;
}

/** Fail open — a health miss must not block Ultra from trying remux. */
export async function remuxHasCapacity(): Promise<boolean> {
  try {
    const response = await fetch(`${TRANSCODER_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REMUX_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return true;
    const health = (await response.json()) as TranscoderHealth;
    const active = Number(health.activeRemuxes ?? 0);
    const starting = Number(health.startingRemuxes ?? 0);
    const max = Number(health.remuxMaxConcurrent ?? 0);
    if (!Number.isFinite(max) || max <= 0) return true;
    return active + starting < max;
  } catch {
    return true;
  }
}
