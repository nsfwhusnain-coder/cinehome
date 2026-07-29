/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { fetchProxied } from "./hls-proxy";
import type { HlsSession } from "./hls-session";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function session(url: string): HlsSession {
  const host = new URL(url).hostname;
  return {
    id: "client-abort-test",
    userId: "user",
    referer: "https://player.example/watch",
    origin: "https://player.example",
    userAgent: "test",
    cookies: "",
    extraHeaders: {},
    rootUrl: url,
    allowedHosts: new Set([host]),
    expiresAt: Date.now() + 60_000,
  };
}

describe("HLS proxy client abort ownership", () => {
  it("returns 499 and never negative-caches an intentionally cancelled segment", async () => {
    const upstream = `https://cdn-client-abort-${Date.now()}.example/video/segment.ts`;
    let calls = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls++;
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(
        new Uint8Array([0x47, 0x40, 0x00, 0x10]) as unknown as BodyInit,
        {
          status: 200,
          headers: { "Content-Type": "video/mp2t" },
        }
      );
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const cancelled = await fetchProxied(
      session(upstream),
      upstream,
      null,
      controller.signal
    );
    expect(cancelled.status).toBe(499);

    const replacement = await fetchProxied(
      session(upstream),
      upstream,
      null
    );
    expect(replacement.status).toBe(200);
    expect(calls).toBe(2);
  });
});
