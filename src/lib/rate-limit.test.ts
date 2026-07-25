/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows requests under the limit and decrements remaining", () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1_000 });
    const now = 1_000_000;

    const r1 = rl.consume("user-1", now);
    const r2 = rl.consume("user-1", now);
    const r3 = rl.consume("user-1", now);

    expect(r1).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(r2).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(r3).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it("rejects once the limit is exhausted within the window", () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000 });
    const now = 1_000_000;

    rl.consume("user-1", now);
    rl.consume("user-1", now);
    const blocked = rl.consume("user-1", now + 10);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets quota once the window elapses", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000 });
    const now = 1_000_000;

    expect(rl.consume("user-1", now).allowed).toBe(true);
    expect(rl.consume("user-1", now + 500).allowed).toBe(false);
    // Window fully elapsed — fresh bucket.
    expect(rl.consume("user-1", now + 1_000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000 });
    const now = 1_000_000;

    expect(rl.consume("user-1", now).allowed).toBe(true);
    expect(rl.consume("user-2", now).allowed).toBe(true);
    expect(rl.consume("user-1", now).allowed).toBe(false);
  });

  it("peek does not consume quota", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000 });
    const now = 1_000_000;

    expect(rl.peek("user-1", now).allowed).toBe(true);
    expect(rl.peek("user-1", now).allowed).toBe(true);
    expect(rl.consume("user-1", now).allowed).toBe(true);
    expect(rl.peek("user-1", now).allowed).toBe(false);
  });

  it("reset clears a key's usage", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000 });
    const now = 1_000_000;

    expect(rl.consume("user-1", now).allowed).toBe(true);
    expect(rl.consume("user-1", now).allowed).toBe(false);
    rl.reset("user-1");
    expect(rl.consume("user-1", now).allowed).toBe(true);
  });

  it("prunes expired entries on the next prune-interval boundary", () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 10 });
    const now = 1_000_000;

    rl.consume("a", now);
    rl.consume("b", now);
    rl.consume("c", now);
    expect(rl.size()).toBe(3);

    // PRUNE_INTERVAL_MS is 60s internally; jump far enough ahead that both
    // the interval gate and each bucket's own window have elapsed.
    rl.consume("d", now + 120_000);

    // a/b/c are long expired (window was 10ms) and get swept on this call;
    // only the fresh "d" bucket remains.
    expect(rl.size()).toBe(1);
  });
});
