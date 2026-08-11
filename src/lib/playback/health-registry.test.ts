import { describe, expect, test } from "bun:test";
import {
  HierarchicalHealthRegistry,
  sourcesWithProviderHealth,
} from "./health-registry";
import type {
  PlaybackSource,
  PlayerFeedback,
  ProviderHealthKey,
} from "./types";

const key: ProviderHealthKey = {
  provider: "Vixsrc",
  contentClass: "movie",
  domain: "vidsrc.example",
  route: "browser_intercept",
  cdnFamily: "cdn.example",
};

let feedbackSequence = 0;

function feedback(
  event: PlayerFeedback["event"],
  timeToFirstFrameMs?: number,
  attemptId = `attempt-${++feedbackSequence}`
): PlayerFeedback {
  return {
    event,
    sourceId: "source",
    provider: "Vixsrc",
    attemptId,
    occurredAt: Date.now(),
    timeToFirstFrameMs,
  };
}

describe("hierarchical provider health", () => {
  test("uses specific buckets after enough samples and tracks median TTFF", () => {
    const registry = new HierarchicalHealthRegistry(2);
    registry.observe(key, feedback("first_frame", 900));
    registry.observe(key, feedback("first_frame", 500));
    const result = registry.lookup(key);
    expect(result.sampleCount).toBe(2);
    expect(result.successRate).toBe(1);
    expect(result.medianFirstSegmentMs).toBe(700);
  });

  test("falls back through parent keys and never counts stalls globally", () => {
    const registry = new HierarchicalHealthRegistry(2);
    registry.observe({ provider: "Vixsrc" }, feedback("handoff_failed"));
    registry.observe({ provider: "Vixsrc" }, feedback("first_frame", 400));
    registry.observe(key, feedback("stall"));
    const result = registry.lookup(key);
    expect(result.sampleCount).toBe(2);
    expect(result.successRate).toBe(0.5);
  });

  test("only terminal handoffs count as failures", () => {
    const registry = new HierarchicalHealthRegistry(1);
    registry.observe(key, feedback("decode_error"));
    registry.observe(key, feedback("stall"));

    expect(registry.lookup(key).sampleCount).toBe(0);

    registry.observe(key, feedback("handoff_failed"));
    expect(registry.lookup(key).successRate).toBe(0);
  });

  test("opens a short cooldown after consecutive terminal failures", () => {
    const registry = new HierarchicalHealthRegistry(1, 64, 2, 60_000);
    registry.observe(key, feedback("handoff_failed"));
    registry.observe(key, feedback("handoff_failed"));

    expect(registry.lookup(key).cooldownUntil).toBeGreaterThan(Date.now());

    registry.observe(key, feedback("first_frame", 300));
    expect(registry.lookup(key).cooldownUntil).toBeGreaterThan(Date.now());
  });

  test("terminal failure replaces the same attempt's first-frame success", () => {
    const registry = new HierarchicalHealthRegistry(1, 64, 3, 60_000);
    for (let index = 0; index < 3; index += 1) {
      const attemptId = `broken-${index}`;
      registry.observe(key, feedback("first_frame", 250, attemptId));
      registry.observe(key, feedback("handoff_failed", undefined, attemptId));
    }

    const result = registry.lookup(key);
    expect(result.sampleCount).toBe(3);
    expect(result.successRate).toBe(0);
    expect(result.cooldownUntil).toBeGreaterThan(Date.now());
  });

  test("attaches fresh health without mutating a cached source", () => {
    const registry = new HierarchicalHealthRegistry(1);
    registry.observe({ provider: "Vixsrc" }, feedback("first_frame", 250));
    const source: PlaybackSource = {
      id: "source",
      url: "https://example.test/master.m3u8",
      provider: "Vixsrc",
      label: "Primary",
      quality: "1080p",
      type: "hls",
    };

    const [decorated] = sourcesWithProviderHealth(
      [source],
      registry,
      { contentClass: "movie" }
    );

    expect(decorated).not.toBe(source);
    expect(decorated?.runtimeHealth?.successRate).toBe(1);
    expect(source.runtimeHealth).toBeUndefined();
  });

  test("keeps one viewer's failures out of another viewer's ranking", () => {
    const registry = new HierarchicalHealthRegistry(1);
    registry.observe(
      { provider: "Vixsrc", viewerId: "viewer-a" },
      feedback("handoff_failed")
    );

    expect(
      registry.lookup({ provider: "Vixsrc", viewerId: "viewer-a" }).sampleCount
    ).toBe(1);
    expect(
      registry.lookup({ provider: "Vixsrc", viewerId: "viewer-b" }).sampleCount
    ).toBe(0);
  });

  test("bounds provider buckets", () => {
    const registry = new HierarchicalHealthRegistry(1, 64, 3, 90_000, 2);
    registry.observe({ provider: "one" }, feedback("first_frame", 100));
    registry.observe({ provider: "two" }, feedback("first_frame", 100));
    registry.observe({ provider: "three" }, feedback("first_frame", 100));

    expect(registry.lookup({ provider: "one" }).sampleCount).toBe(0);
    expect(registry.lookup({ provider: "three" }).sampleCount).toBe(1);
  });
});
