import type { RateLimiter, RateLimitResult } from "@/lib/rate-limit";

type ResolveLimiter = Pick<RateLimiter, "consume">;

export interface ResolveBudgetResult {
  allowed: boolean;
  retryAfterMs: number;
  deniedScope: "title" | "user" | null;
}

/**
 * Consume the narrow title bucket before the wide user bucket.
 *
 * Once a title is closed, repeated requests for it must not drain the user's
 * cross-title allowance. Recovery bypasses the normal title bucket and remains
 * subject to the wide user ceiling plus its dedicated recovery limiter.
 */
export function consumePlaybackResolveBudget(args: {
  userLimiter: ResolveLimiter;
  titleLimiter: ResolveLimiter;
  userKey: string;
  titleKey: string;
  consumeTitle: boolean;
}): ResolveBudgetResult {
  let titleCheck: RateLimitResult | null = null;
  if (args.consumeTitle) {
    titleCheck = args.titleLimiter.consume(args.titleKey);
    if (!titleCheck.allowed) {
      return {
        allowed: false,
        retryAfterMs: titleCheck.retryAfterMs,
        deniedScope: "title",
      };
    }
  }

  const userCheck = args.userLimiter.consume(args.userKey);
  if (!userCheck.allowed) {
    return {
      allowed: false,
      retryAfterMs: userCheck.retryAfterMs,
      deniedScope: "user",
    };
  }

  return { allowed: true, retryAfterMs: 0, deniedScope: null };
}
