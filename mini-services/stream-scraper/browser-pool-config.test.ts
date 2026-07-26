import { describe, expect, it } from "bun:test";
import {
  BROWSER_POOL_DEFAULT,
  BROWSER_POOL_MAX,
  BROWSER_POOL_MIN,
  browserPoolSize,
} from "./browser-pool-config";

describe("browserPoolSize", () => {
  it("uses the bounded production default when unset or invalid", () => {
    expect(browserPoolSize(undefined)).toBe(BROWSER_POOL_DEFAULT);
    expect(browserPoolSize("")).toBe(BROWSER_POOL_DEFAULT);
    expect(browserPoolSize("not-a-number")).toBe(BROWSER_POOL_DEFAULT);
  });

  it("accepts an in-range operator override", () => {
    expect(browserPoolSize("4")).toBe(4);
  });

  it("clamps overrides to the supported resource envelope", () => {
    expect(browserPoolSize("1")).toBe(BROWSER_POOL_MIN);
    expect(browserPoolSize("50")).toBe(BROWSER_POOL_MAX);
  });
});
