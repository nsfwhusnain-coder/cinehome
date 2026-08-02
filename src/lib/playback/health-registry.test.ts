import { describe, expect, test } from "bun:test";
import { HierarchicalHealthRegistry } from "./health-registry";
import type { PlayerFeedback, ProviderHealthKey } from "./types";

const key: ProviderHealthKey = {
  provider: "Vixsrc",
  contentClass: "movie",
  domain: "vidsrc.example",
  route: "browser_intercept",
  cdnFamily: "cdn.example",
};

function feedback(
  event: PlayerFeedback["event"],
  timeToFirstFrameMs?: number
): PlayerFeedback {
  return {
    event,
    sourceId: "source",
    provider: "Vixsrc",
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
    expect(result.medianFirstSegmentMs).toBe(900);
  });

  test("falls back through parent keys and never counts stalls globally", () => {
    const registry = new HierarchicalHealthRegistry(2);
    registry.observe({ provider: "Vixsrc" }, feedback("decode_error"));
    registry.observe({ provider: "Vixsrc" }, feedback("first_frame", 400));
    registry.observe(key, feedback("stall"));
    const result = registry.lookup(key);
    expect(result.sampleCount).toBe(2);
    expect(result.successRate).toBe(0.5);
  });
});
