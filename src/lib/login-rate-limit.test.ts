/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { checkAuthRateLimit, clearAuthFailures, recordAuthFailure } from "./login-rate-limit";

/**
 * Covers the KD-sec fix #7 escalating-lockout behavior. `Date.now` is
 * monkey-patched per test (restored in `afterEach`) since the module always
 * reads real time internally. Every test uses a unique username/IP pair —
 * the module's Maps are shared across the whole file, so distinct keys keep
 * tests independent of each other and of run order.
 */

const REAL_NOW = Date.now;

function setNow(ts: number): void {
  Date.now = () => ts;
}

afterEach(() => {
  Date.now = REAL_NOW;
});

let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return `kd-sec-fix7-${idCounter}`;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe("login-rate-limit escalating lockout", () => {
  it("allows attempts under the failure cap", () => {
    const user = uniqueId();
    const ip = `${uniqueId()}.ip`;
    setNow(T0);

    for (let i = 0; i < 4; i++) {
      expect(checkAuthRateLimit(user, ip).allowed).toBe(true);
      recordAuthFailure(user, ip);
    }
    expect(checkAuthRateLimit(user, ip).allowed).toBe(true);
  });

  it("locks out for the base 15-minute window on the first offense", () => {
    const user = uniqueId();
    const ip = `${uniqueId()}.ip`;
    setNow(T0);

    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);

    const result = checkAuthRateLimit(user, ip);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeLessThanOrEqual(FIFTEEN_MIN_MS);
    expect(result.retryAfterMs).toBeGreaterThan(FIFTEEN_MIN_MS - 1_000);
  });

  it("doubles the lockout window on a repeat offense within the memory horizon", () => {
    const user = uniqueId();
    const ip = `${uniqueId()}.ip`;
    let t = T0;
    setNow(t);

    // First lockout cycle.
    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);
    expect(checkAuthRateLimit(user, ip).allowed).toBe(false);

    // Move just past the first (15-min) window's expiry.
    t += FIFTEEN_MIN_MS + 1_000;
    setNow(t);
    expect(checkAuthRateLimit(user, ip).allowed).toBe(true);

    // Second offense — should escalate to a noticeably longer lockout.
    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);
    const second = checkAuthRateLimit(user, ip);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(FIFTEEN_MIN_MS * 1.5);
  });

  it("forgives escalation after a long idle gap (never permanent)", () => {
    const user = uniqueId();
    const ip = `${uniqueId()}.ip`;
    let t = T0;
    setNow(t);

    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);
    expect(checkAuthRateLimit(user, ip).allowed).toBe(false);

    // Jump well past the 24h lockout-memory horizon with no further attempts.
    t += 25 * 60 * 60 * 1000;
    setNow(t);

    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);
    const result = checkAuthRateLimit(user, ip);
    expect(result.allowed).toBe(false);
    // Back to the base window, not further escalated by the earlier offense.
    expect(result.retryAfterMs).toBeLessThanOrEqual(FIFTEEN_MIN_MS);
    expect(result.retryAfterMs).toBeGreaterThan(FIFTEEN_MIN_MS - 1_000);
  });

  it("a successful login clears failures and escalation immediately", () => {
    const user = uniqueId();
    const ip = `${uniqueId()}.ip`;
    setNow(T0);

    for (let i = 0; i < 5; i++) recordAuthFailure(user, ip);
    expect(checkAuthRateLimit(user, ip).allowed).toBe(false);

    clearAuthFailures(user, ip);
    expect(checkAuthRateLimit(user, ip).allowed).toBe(true);
  });

  it("does not lock out an unrelated username sharing the same IP prefix", () => {
    const userA = uniqueId();
    const userB = uniqueId();
    const ip = `${uniqueId()}.ip`;
    setNow(T0);

    for (let i = 0; i < 5; i++) recordAuthFailure(userA, ip);
    expect(checkAuthRateLimit(userA, ip).allowed).toBe(false);
    // Different username, same soft IP bucket — 5 failures is well under the
    // IP's own (much higher) soft cap, so userB is unaffected.
    expect(checkAuthRateLimit(userB, ip).allowed).toBe(true);
  });
});
