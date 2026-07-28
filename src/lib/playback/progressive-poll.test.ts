/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  PROGRESSIVE_POLL_INTERVAL_BASE_MS,
  PROGRESSIVE_POLL_INTERVAL_LATER_MS,
  progressivePollInterval,
  type ProgressivePollState,
} from "./progressive-poll";

const PARTIAL_THIN: ProgressivePollState = {
  rateLimited: false,
  hasAuthoritativeData: true,
  fetching: false,
  partial: true,
  usableSourceCount: 1,
  extraFetches: 0,
  elapsedMs: 0,
};

describe("progressive playback polling", () => {
  it("stops on an authoritative complete roster even when it has one source", () => {
    expect(progressivePollInterval({ ...PARTIAL_THIN, partial: false })).toBe(false);
  });

  it("polls an explicitly partial thin roster quickly", () => {
    expect(progressivePollInterval(PARTIAL_THIN)).toBe(
      PROGRESSIVE_POLL_INTERVAL_BASE_MS
    );
  });

  it("backs off after the early thin-roster attempts", () => {
    expect(
      progressivePollInterval({
        ...PARTIAL_THIN,
        usableSourceCount: 3,
        extraFetches: 3,
      })
    ).toBe(PROGRESSIVE_POLL_INTERVAL_LATER_MS);
  });

  it("stops when the healthy roster target is reached", () => {
    expect(
      progressivePollInterval({ ...PARTIAL_THIN, usableSourceCount: 4 })
    ).toBe(false);
  });

  it("stops at the refetch and wall-clock budgets", () => {
    expect(progressivePollInterval({ ...PARTIAL_THIN, extraFetches: 5 })).toBe(
      false
    );
    expect(progressivePollInterval({ ...PARTIAL_THIN, elapsedMs: 30_000 })).toBe(
      false
    );
  });

  it("never polls a closed rate-limit bucket or an in-flight request", () => {
    expect(progressivePollInterval({ ...PARTIAL_THIN, rateLimited: true })).toBe(
      false
    );
    expect(progressivePollInterval({ ...PARTIAL_THIN, fetching: true })).toBe(
      false
    );
  });
});
