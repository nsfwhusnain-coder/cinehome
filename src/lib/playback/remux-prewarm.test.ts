import { describe, expect, test } from "bun:test";
import { prewarmRemuxPosition } from "./remux-prewarm";

const manifest = "#EXTM3U\n#EXT-X-VERSION:7\n";

describe("remux position prewarm", () => {
  test("retries transient busy responses until the offset is ready", async () => {
    const statuses = [503, 502, 200];
    const waits: number[] = [];
    let calls = 0;

    await prewarmRemuxPosition("/api/transcode?startAt=3594", {
      signal: new AbortController().signal,
      retryDelaysMs: [0, 1_000, 2_000, 4_000],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      fetcher: async () => {
        const status = statuses[calls++] ?? 500;
        return new Response(status === 200 ? manifest : "busy", { status });
      },
    });

    expect(calls).toBe(3);
    expect(waits).toEqual([0, 1_000, 2_000]);
  });

  test("does not retry a permanent request error", async () => {
    let calls = 0;

    await expect(
      prewarmRemuxPosition("/api/transcode?startAt=3594", {
        signal: new AbortController().signal,
        retryDelaysMs: [0, 1_000, 2_000],
        wait: async () => {},
        fetcher: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      })
    ).rejects.toThrow("404");

    expect(calls).toBe(1);
  });

  test("cancels retry backoff when a newer seek replaces it", async () => {
    const controller = new AbortController();
    let calls = 0;

    await expect(
      prewarmRemuxPosition("/api/transcode?startAt=3594", {
        signal: controller.signal,
        retryDelaysMs: [0, 1_000],
        fetcher: async () => {
          calls += 1;
          controller.abort();
          throw new TypeError("network interrupted");
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toBe(1);
  });
});
