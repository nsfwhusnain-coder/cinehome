/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { ProviderOutageError } from "./provider-outage";
import { resolveVixsrc } from "./vixsrc";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveVixsrc outages vs title miss", () => {
  it("returns [] on 200 without src (title miss, not an outage)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(resolveVixsrc(550, "movie")).resolves.toEqual([]);
  });

  it("throws on HTTP 502", async () => {
    globalThis.fetch = (async () =>
      new Response("down", { status: 502 })) as unknown as typeof fetch;
    await expect(resolveVixsrc(550, "movie")).rejects.toBeInstanceOf(
      ProviderOutageError
    );
  });
});
