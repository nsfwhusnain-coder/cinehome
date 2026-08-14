/**
 * Classify provider HTTP failures so title-miss `[]` stays a circuit success
 * while real outages (timeout / 5xx / network) can open the breaker.
 */

export const PROVIDER_OUTAGE_HTTP_MIN = 500;

export type ProviderOutageKind = "timeout" | "http_5xx" | "network";

export class ProviderOutageError extends Error {
  readonly kind: ProviderOutageKind;
  readonly status: number | null;

  constructor(
    message: string,
    kind: ProviderOutageKind,
    status: number | null = null
  ) {
    super(message);
    this.name = "ProviderOutageError";
    this.kind = kind;
    this.status = status;
  }
}

export function isProviderOutageError(err: unknown): err is ProviderOutageError {
  return err instanceof ProviderOutageError;
}

export function isAbortOrTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const message = "message" in err ? String(err.message) : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /abort|timeout/i.test(message)
  );
}

export function isNetworkThrow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isProviderOutageError(err) || isAbortOrTimeoutError(err)) return false;
  return (
    err.name === "TypeError" ||
    /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(err.message)
  );
}

export function throwIfHttpOutage(status: number, provider: string): void {
  if (status >= PROVIDER_OUTAGE_HTTP_MIN) {
    throw new ProviderOutageError(
      `${provider}_http_${status}`,
      "http_5xx",
      status
    );
  }
}

/** Re-throw classified outages; leave parse / title-miss errors to the caller. */
export function rethrowIfProviderOutage(err: unknown, provider: string): void {
  if (isProviderOutageError(err)) throw err;
  if (isAbortOrTimeoutError(err)) {
    throw new ProviderOutageError(`${provider}_timeout`, "timeout");
  }
  if (isNetworkThrow(err)) {
    throw new ProviderOutageError(`${provider}_network`, "network");
  }
}
