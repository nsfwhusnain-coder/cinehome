/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
  isAbortLikeError,
  readResponseBodyForCache,
  SEGMENT_BODY_CACHE_ENABLED,
  SEGMENT_CACHE_ENTRY_MAX_BYTES,
} from "./hls-proxy";

describe("HLS proxy cache memory envelope", () => {
  it("recognizes deliberate stream cancellation errors", () => {
    expect(isAbortLikeError(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isAbortLikeError({ name: "AbortError" })).toBe(true);
    expect(isAbortLikeError(new Error("upstream failed"))).toBe(false);
  });

  it("does not tee media bodies into the app heap in production", () => {
    expect(SEGMENT_BODY_CACHE_ENABLED).toBe(false);
  });

  it("rejects an oversized declared body before reading it", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      headers: {
        "content-length": String(SEGMENT_CACHE_ENTRY_MAX_BYTES + 1),
      },
    });

    expect(await readResponseBodyForCache(response)).toBeNull();
    expect(response.body?.locked).toBe(false);
    await response.body?.cancel();
  });

  it("cancels a chunked body once it crosses the hard cap", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    expect(await readResponseBodyForCache(response, 16)).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("keeps a complete body that fits inside the cap", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));
    const body = await readResponseBodyForCache(response, 16);

    expect(body).not.toBeNull();
    expect([...new Uint8Array(body!)]).toEqual([1, 2, 3, 4]);
  });
});
