/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  abortAllPreresolve,
  preresolvePlayback,
} from "./playback-preresolve";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
});

afterEach(async () => {
  abortAllPreresolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

function abortablePendingFetch(
  calls: Array<{ url: string; signal: AbortSignal }>
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new Error("pre-resolve fetch did not receive an AbortSignal");
    }
    calls.push({ url: String(input), signal });
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    });
  }) as typeof fetch;
}

describe("playback pre-resolution queue", () => {
  it("deduplicates concurrent work for the same title", async () => {
    let calls = 0;
    let finish = (_response: Response): void => {
      throw new Error("fetch resolver was not installed");
    };
    globalThis.fetch = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as unknown as typeof fetch;

    const first = preresolvePlayback({ mediaType: "movie", tmdbId: 910_001 });
    const second = preresolvePlayback({ mediaType: "movie", tmdbId: 910_001 });

    expect(second).toBe(first);
    expect(calls).toBe(1);
    finish(
      new Response(JSON.stringify({ status: "available", sources: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(first).resolves.toMatchObject({ status: "available" });
  });

  it("aborts active and queued work without leaving poisoned in-flight keys", async () => {
    const calls: Array<{ url: string; signal: AbortSignal }> = [];
    globalThis.fetch = abortablePendingFetch(calls);

    const requests = [910_011, 910_012, 910_013, 910_014].map((tmdbId) =>
      preresolvePlayback({ mediaType: "movie", tmdbId })
    );
    expect(calls).toHaveLength(3);

    abortAllPreresolve();
    await expect(Promise.all(requests)).resolves.toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);

    await Promise.resolve();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "available", sources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )) as unknown as typeof fetch;
    await expect(
      preresolvePlayback({ mediaType: "movie", tmdbId: 910_014 })
    ).resolves.toMatchObject({ status: "available" });
  });
});
