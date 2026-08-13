import type { SourceProbeMetrics } from "./types";

interface ReachabilityProbeOptions {
  timeoutMs: number;
  signal: AbortSignal;
  speedScore: (ttfbMs: number) => number;
  fetchImpl?: typeof fetch;
}

type ProbeTask = (
  url: string,
  signal: AbortSignal
) => Promise<SourceProbeMetrics | null>;

function failedProbe(timeoutMs: number): SourceProbeMetrics {
  return { ok: false, ttfbMs: timeoutMs, bytesPerSec: 0, speedScore: 0 };
}

export async function probeSameOriginSource(
  url: string,
  options: ReachabilityProbeOptions
): Promise<SourceProbeMetrics | null> {
  if (options.signal.aborted) return null;
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), options.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      mode: "same-origin",
      signal: abort.signal,
      headers: { Range: "bytes=0-16384" },
    });
    await response.body?.cancel().catch(() => undefined);
    if (options.signal.aborted) return null;
    const ttfbMs = Math.max(1, Date.now() - startedAt);
    const ok = response.ok || response.status === 206;
    return {
      ok,
      ttfbMs,
      bytesPerSec: 0,
      speedScore: ok ? options.speedScore(ttfbMs) : 0,
    };
  } catch {
    return options.signal.aborted ? null : failedProbe(options.timeoutMs);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

export async function runBoundedHealthProbes(
  urls: readonly string[],
  concurrency: number,
  signal: AbortSignal,
  probe: ProbeTask,
  onEach: (url: string, result: SourceProbeMetrics) => void
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted && cursor < urls.length) {
      const url = urls[cursor++]!;
      const result = await probe(url, signal);
      if (result && !signal.aborted) onEach(url, result);
    }
  };
  const workerCount = Math.min(Math.max(0, concurrency), urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
