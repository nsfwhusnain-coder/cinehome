/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEAD_HOST_COOLDOWN_MS,
  PROBE_STALL_TIMEOUT_MS,
  isEmbedHostDead,
  isHardEmbedFailure,
  recordEmbedOutcome,
  resetEmbedHealth,
} from "./embed-health";

/**
 * Per-embed-host dead-provider tracker (robustness item added for the embed
 * roster expansion pass — see .claude/handoffs/agent-l-embeds.md). Live
 * probing of ~20 candidate providers found several DNS-dead / SSL-broken
 * hosts; this is the mechanism that short-circuits a host like that for the
 * rest of the boot instead of re-attempting it (and burning a Playwright
 * worker slot) on every future scrape.
 */
describe("isHardEmbedFailure", () => {
  it("classifies a tryScrapeUrl exception as a hard failure", () => {
    expect(isHardEmbedFailure("Scrape failed: net::ERR_NAME_NOT_RESOLVED")).toBe(true);
    expect(isHardEmbedFailure("Scrape failed: Timeout 20000ms exceeded")).toBe(true);
  });

  it("does NOT classify a soft title-miss or timeout as a hard failure", () => {
    expect(isHardEmbedFailure("No stream URL found.")).toBe(false);
    expect(isHardEmbedFailure("Stream found but playback verification failed.")).toBe(false);
    expect(isHardEmbedFailure("timed out")).toBe(false);
    expect(isHardEmbedFailure("cancelled")).toBe(false);
  });

  it("handles undefined (no error at all)", () => {
    expect(isHardEmbedFailure(undefined)).toBe(false);
  });
});

describe("recordEmbedOutcome / isEmbedHostDead", () => {
  beforeEach(() => {
    resetEmbedHealth();
  });

  it("a fresh host is never dead", () => {
    expect(isEmbedHostDead("fresh-host.example")).toBe(false);
  });

  // Policy: DEAD_AFTER_FAILURES = 2 (embed-health.ts) — kill after 2 hard fails.
  it("stays alive after 1 hard failure (below the 2-strike floor)", () => {
    recordEmbedOutcome("flaky.example", false);
    expect(isEmbedHostDead("flaky.example")).toBe(false);
  });

  it("goes dead after 2 consecutive hard failures", () => {
    recordEmbedOutcome("dead.example", false);
    recordEmbedOutcome("dead.example", false);
    expect(isEmbedHostDead("dead.example")).toBe(true);
  });

  it("a success resets the failure counter (heals a flaky-but-alive host)", () => {
    recordEmbedOutcome("recovering.example", false);
    recordEmbedOutcome("recovering.example", true);
    recordEmbedOutcome("recovering.example", false);
    // One fail after heal — still below 2-strike floor.
    expect(isEmbedHostDead("recovering.example")).toBe(false);
  });

  it("a success after being marked dead revives the host", () => {
    recordEmbedOutcome("revive.example", false);
    recordEmbedOutcome("revive.example", false);
    expect(isEmbedHostDead("revive.example")).toBe(true);
    recordEmbedOutcome("revive.example", true);
    expect(isEmbedHostDead("revive.example")).toBe(false);
  });

  it("hosts are tracked independently", () => {
    recordEmbedOutcome("a.example", false);
    recordEmbedOutcome("a.example", false);
    recordEmbedOutcome("b.example", false);
    expect(isEmbedHostDead("a.example")).toBe(true);
    expect(isEmbedHostDead("b.example")).toBe(false);
  });
});

/**
 * Roster hygiene (2026-07-21): the dead-host short-circuit must be BOUNDED and
 * SELF-HEALING — a host that persistently fails is skipped fast on later
 * scrapes, but it can always come back (no permanent blacklist) and only ever
 * gets one live re-check per cooldown window (no unbounded / "infinite
 * searching" re-probing).
 */
describe("bounded cooldown + self-heal (no permanent blacklist)", () => {
  const realNow = Date.now;
  let mockedNow = realNow();

  beforeEach(() => {
    resetEmbedHealth();
    mockedNow = realNow();
    Date.now = () => mockedNow;
  });

  afterEach(() => {
    Date.now = realNow;
  });

  it("stays short-circuited for the whole cooldown window", () => {
    recordEmbedOutcome("cooling.example", false);
    recordEmbedOutcome("cooling.example", false);
    expect(isEmbedHostDead("cooling.example")).toBe(true);

    mockedNow += DEAD_HOST_COOLDOWN_MS - 1;
    expect(isEmbedHostDead("cooling.example")).toBe(true);
  });

  it("allows exactly one bounded probe through once the cooldown elapses", () => {
    recordEmbedOutcome("probe.example", false);
    recordEmbedOutcome("probe.example", false);
    mockedNow += DEAD_HOST_COOLDOWN_MS;

    // First call after cooldown claims the single probe slot.
    expect(isEmbedHostDead("probe.example")).toBe(false);
    // A concurrent/second call during the same in-flight probe stays short-circuited
    // — never more than one live attempt per cooldown window (bounded, not "infinite searching").
    expect(isEmbedHostDead("probe.example")).toBe(true);
  });

  it("an exhausted-roster recovery claims one immediate half-open probe", () => {
    recordEmbedOutcome("recovery.example", false);
    recordEmbedOutcome("recovery.example", false);

    expect(isEmbedHostDead("recovery.example")).toBe(true);
    expect(isEmbedHostDead("recovery.example", true)).toBe(false);
    expect(isEmbedHostDead("recovery.example", true)).toBe(true);

    recordEmbedOutcome("recovery.example", true);
    expect(isEmbedHostDead("recovery.example")).toBe(false);
  });

  it("a successful bounded probe revives the host immediately (self-healing)", () => {
    recordEmbedOutcome("revives.example", false);
    recordEmbedOutcome("revives.example", false);
    mockedNow += DEAD_HOST_COOLDOWN_MS;

    expect(isEmbedHostDead("revives.example")).toBe(false); // probe let through
    recordEmbedOutcome("revives.example", true); // probe succeeded
    expect(isEmbedHostDead("revives.example")).toBe(false); // fully alive again
  });

  it("a failed bounded probe renews the cooldown instead of retrying every call", () => {
    recordEmbedOutcome("stillDead.example", false);
    recordEmbedOutcome("stillDead.example", false);
    mockedNow += DEAD_HOST_COOLDOWN_MS;

    expect(isEmbedHostDead("stillDead.example")).toBe(false); // probe let through
    recordEmbedOutcome("stillDead.example", false); // probe failed again

    // Immediately short-circuited again — not a permanent block, just a fresh window.
    expect(isEmbedHostDead("stillDead.example")).toBe(true);

    // Bounded, not permanent: another full cooldown window opens probing again.
    mockedNow += DEAD_HOST_COOLDOWN_MS;
    expect(isEmbedHostDead("stillDead.example")).toBe(false);
  });

  it("a stalled probe (crash before recordEmbedOutcome) auto-releases — never wedged dead forever", () => {
    recordEmbedOutcome("stalled.example", false);
    recordEmbedOutcome("stalled.example", false);
    mockedNow += DEAD_HOST_COOLDOWN_MS;

    expect(isEmbedHostDead("stalled.example")).toBe(false); // claims the probe slot
    expect(isEmbedHostDead("stalled.example")).toBe(true); // a concurrent caller waits

    // Probe never resolved (e.g. crash) — once PROBE_STALL_TIMEOUT_MS passes, release it.
    mockedNow += PROBE_STALL_TIMEOUT_MS;
    expect(isEmbedHostDead("stalled.example")).toBe(false);
  });

  it("boot-dead hosts are not a permanent blacklist — they follow the same bounded cycle", () => {
    // embed.su is seeded dead at boot (see BOOT_DEAD_HOSTS in embed-health.ts).
    expect(isEmbedHostDead("embed.su")).toBe(true);
    mockedNow += DEAD_HOST_COOLDOWN_MS;
    expect(isEmbedHostDead("embed.su")).toBe(false); // bounded probe allowed through
    recordEmbedOutcome("embed.su", true);
    expect(isEmbedHostDead("embed.su")).toBe(false); // revived
  });
});
