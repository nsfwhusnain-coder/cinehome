/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  isAbortOrTimeoutError,
  isNetworkThrow,
  isProviderOutageError,
  ProviderOutageError,
  rethrowIfProviderOutage,
  throwIfHttpOutage,
} from "./provider-outage";

describe("throwIfHttpOutage", () => {
  it("throws on HTTP >= 500 and ignores 4xx / 200", () => {
    expect(() => throwIfHttpOutage(200, "vixsrc")).not.toThrow();
    expect(() => throwIfHttpOutage(404, "vixsrc")).not.toThrow();
    expect(() => throwIfHttpOutage(429, "videasy")).toThrow(ProviderOutageError);
    expect(() => throwIfHttpOutage(500, "vixsrc")).toThrow(ProviderOutageError);
    try {
      throwIfHttpOutage(502, "videasy");
    } catch (err) {
      expect(isProviderOutageError(err)).toBe(true);
      expect(err).toMatchObject({ kind: "http_5xx", status: 502 });
      expect((err as Error).message).toBe("videasy_http_502");
    }
  });
});

describe("rethrowIfProviderOutage", () => {
  it("rewraps abort / timeout / network and leaves parse errors", () => {
    const timeout = new DOMException("The operation was aborted.", "TimeoutError");
    expect(() => rethrowIfProviderOutage(timeout, "vidrock")).toThrow(
      /vidrock_timeout/
    );

    const network = new TypeError("fetch failed");
    expect(() => rethrowIfProviderOutage(network, "notorrent")).toThrow(
      /notorrent_network/
    );

    expect(() => rethrowIfProviderOutage(new SyntaxError("bad json"), "vixsrc")).not.toThrow();
    expect(isAbortOrTimeoutError(timeout)).toBe(true);
    expect(isNetworkThrow(network)).toBe(true);
    expect(isNetworkThrow(new SyntaxError("bad json"))).toBe(false);
  });
});
