/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  probeSameOriginSource,
  runBoundedHealthProbes,
} from "./background-health-probe";

describe("background source health probes", () => {
  it("cancels the body when an origin ignores the requested Range", async () => {
    let cancelled = false;
    let range = "";
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      range = new Headers(init?.headers).get("range") ?? "";
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const controller = new AbortController();

    const result = await probeSameOriginSource("/api/hls/session", {
      timeoutMs: 4_000,
      signal: controller.signal,
      speedScore: () => 50,
      fetchImpl,
    });

    expect(result?.ok).toBe(true);
    expect(range).toBe("bytes=0-16384");
    expect(cancelled).toBe(true);
  });

  it("stops launching queued probes after navigation abort", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const delivered: string[] = [];
    const probe = async (
      url: string,
      signal: AbortSignal
    ): Promise<null> => {
      started.push(url);
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    };
    const pending = runBoundedHealthProbes(
      ["one", "two", "three", "four"],
      2,
      controller.signal,
      probe,
      (url) => delivered.push(url)
    );
    await Promise.resolve();
    controller.abort();
    await pending;

    expect(started).toEqual(["one", "two"]);
    expect(delivered).toEqual([]);
  });
});
