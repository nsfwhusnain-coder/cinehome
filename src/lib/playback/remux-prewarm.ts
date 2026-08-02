const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000] as const;

export interface RemuxPrewarmOptions {
  signal: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

async function waitWithAbort(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (delayMs <= 0) return;
  if (signal.aborted) throw abortError();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Prepare an offset remux without giving up on the first transient failure.
 *
 * Requests for the same offset share the transcoder cache key, so retrying
 * does not start duplicate ffmpeg jobs. The caller owns the AbortSignal: a new
 * seek cancels both an in-flight request and any pending backoff immediately.
 */
export async function prewarmRemuxPosition(
  url: string,
  options: RemuxPrewarmOptions
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitWithAbort;
  let lastError: Error = new Error("Could not prepare remux position");

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await wait(Math.max(0, delays[attempt] ?? 0), options.signal);
    if (options.signal.aborted) throw abortError();

    try {
      const response = await fetcher(url, {
        cache: "no-store",
        credentials: "include",
        signal: options.signal,
      });

      if (response.ok) {
        const body = await response.text();
        if (body.includes("#EXTM3U")) return;
        lastError = new Error("Invalid seek manifest");
      } else {
        lastError = new Error(`Seek prewarm failed (${response.status})`);
        if (!retryableStatus(response.status)) throw lastError;
      }
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        error instanceof Error &&
        /^Seek prewarm failed \((?:4(?!08|25|29)\d\d)\)$/.test(error.message)
      ) {
        throw error;
      }
    }
  }

  throw lastError;
}
