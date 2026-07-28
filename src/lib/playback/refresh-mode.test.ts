/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  consumesTitleResolveBudget,
  playbackRefreshMode,
} from "./refresh-mode";

describe("playbackRefreshMode", () => {
  it("keeps the unrestricted nocache control admin-only", () => {
    expect(
      playbackRefreshMode({
        fast: false,
        adminNoCacheRequested: true,
        recoveryRefreshRequested: false,
        isAdmin: false,
      })
    ).toBe("none");
    expect(
      playbackRefreshMode({
        fast: false,
        adminNoCacheRequested: true,
        recoveryRefreshRequested: false,
        isAdmin: true,
      })
    ).toBe("admin");
  });

  it("allows an authenticated full-path recovery refresh independent of admin", () => {
    expect(
      playbackRefreshMode({
        fast: false,
        adminNoCacheRequested: false,
        recoveryRefreshRequested: true,
        isAdmin: false,
      })
    ).toBe("recovery");
  });

  it("never makes the latency-critical fast path perform a forced scrape", () => {
    expect(
      playbackRefreshMode({
        fast: true,
        adminNoCacheRequested: true,
        recoveryRefreshRequested: true,
        isAdmin: true,
      })
    ).toBe("none");
  });

  it("reserves the independently-limited recovery path from normal title polling", () => {
    expect(consumesTitleResolveBudget("none")).toBe(true);
    expect(consumesTitleResolveBudget("admin")).toBe(true);
    expect(consumesTitleResolveBudget("recovery")).toBe(false);
  });
});
