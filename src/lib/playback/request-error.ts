export class PlaybackRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PlaybackRequestError";
  }
}

export function isPlaybackRateLimited(error: unknown): boolean {
  return error instanceof PlaybackRequestError && error.status === 429;
}

/**
 * Keep the existing single retry for transient resolver/network failures, but
 * never retry a server-declared rate limit. Progressive polling also uses the
 * same predicate to stop its interval instead of hammering a closed bucket.
 */
export function shouldRetryPlaybackRequest(
  failureCount: number,
  error: unknown
): boolean {
  return !isPlaybackRateLimited(error) && failureCount < 1;
}
