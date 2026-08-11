/// <reference types="bun-types" />
import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  abortAllPreresolve,
  prefetchManifestLite,
  preresolvePlayback,
  selectHlsWarmTarget,
  warmHlsPath,
  warmPreresolvedPlayback,
} from "./playback-preresolve";

const TEST_ORIGIN = "https://app.example";
const ASYNC_SETTLE_MS = 20;
const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
);

function installWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { origin: TEST_ORIGIN } },
  });
}

afterEach(async () => {
  abortAllPreresolve();
  globalThis.fetch = originalFetch;
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
  await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));
});

describe("selectHlsWarmTarget", () => {
  it("chooses the preferred extensionless proxy variant", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720",
      "/api/hls/variant?u=720",
      "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
      "/api/hls/variant?u=1080",
      "#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160",
      "/api/hls/variant?u=2160",
    ].join("\n");

    const target = selectHlsWarmTarget(
      master,
      `${TEST_ORIGIN}/api/hls/master`,
      1080
    );

    expect(target.kind).toBe("variant");
    expect(target.playlistUrl).toBe(`${TEST_ORIGIN}/api/hls/variant?u=1080`);
  });

  it("recognizes a byte-range media playlist without relying on extensions", () => {
    const media = [
      "#EXTM3U",
      "#EXTINF:6.0,",
      "#EXT-X-BYTERANGE:1048576@0",
      "/api/hls/file?u=opaque",
    ].join("\n");

    const target = selectHlsWarmTarget(
      media,
      `${TEST_ORIGIN}/api/hls/variant?u=1080`
    );

    expect(target.kind).toBe("media");
    expect(target.segmentUrl).toBe(`${TEST_ORIGIN}/api/hls/file?u=opaque`);
  });
});

describe("playback pre-resolution cancellation", () => {
  it("aborts an active resolve and permits a clean retry", async () => {
    installWindow();
    let abortObserved = false;
    let firstRequest = true;
    let requestCount = 0;
    globalThis.fetch = (async (_input, init) => {
      requestCount += 1;
      if (!firstRequest) {
        return new Response(JSON.stringify({ status: "available" }), {
          status: 200,
        });
      }
      firstRequest = false;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const first = preresolvePlayback({ mediaType: "movie", tmdbId: 991_001 });
    await Promise.resolve();
    abortAllPreresolve();

    expect(await first).toBeNull();
    expect(abortObserved).toBe(true);
    const retryPromise = preresolvePlayback({
      mediaType: "movie",
      tmdbId: 991_001,
    });
    expect(retryPromise).not.toBe(first);
    const retry = await retryPromise;
    expect(retry).toEqual({ status: "available" });
    expect(requestCount).toBe(2);
  });

  it("drops stale queued hover intent instead of building an unbounded FIFO", async () => {
    installWindow();
    let requestCount = 0;
    globalThis.fetch = (async (_input, init) => {
      requestCount += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const resolves = Array.from({ length: 12 }, (_, index) =>
      preresolvePlayback({ mediaType: "movie", tmdbId: 992_000 + index })
    );

    expect(await resolves[3]).toBeNull();
    expect(requestCount).toBe(3);
  });

  it("releases an active slot when a pre-resolve connection hangs", async () => {
    jest.useFakeTimers();
    try {
      installWindow();
      let abortObserved = false;
      globalThis.fetch = (async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as typeof fetch;

      const result = preresolvePlayback({
        mediaType: "movie",
        tmdbId: 993_001,
      });
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);

      expect(await result).toBeNull();
      expect(abortObserved).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("manifest warmup", () => {
  it("stops at the media playlist and never fetches byte-range media", async () => {
    installWindow();
    const calls: string[] = [];
    const ranges: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(url);
      ranges.push(new Headers(init?.headers).get("range"));
      if (calls.length === 1) {
        return new Response(
          [
            "#EXTM3U",
            "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
            "/api/hls/variant?u=1080",
          ].join("\n"),
          { status: 200 }
        );
      }
      return new Response(
        [
          "#EXTM3U",
          "#EXTINF:6.0,",
          "#EXT-X-BYTERANGE:1048576@0",
          "/api/hls/full-feature-file?u=opaque",
        ].join("\n"),
        { status: 200 }
      );
    }) as typeof fetch;

    prefetchManifestLite("/api/hls/master?u=opaque", "hls");
    await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

    expect(calls).toEqual([
      `${TEST_ORIGIN}/api/hls/master?u=opaque`,
      `${TEST_ORIGIN}/api/hls/variant?u=1080`,
    ]);
    expect(ranges).toEqual([null, null]);
  });

  it("never warms a known progressive source hidden behind the HLS proxy", () => {
    installWindow();
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("unexpected");
    }) as unknown as typeof fetch;

    warmPreresolvedPlayback({
      streamUrl: "/api/hls/session?u=opaque",
      sources: [
        { url: "/api/hls/session?u=opaque", type: "mp4" },
      ],
    });

    expect(fetchCount).toBe(0);
  });

  it("cancels a mislabeled video response without consuming its body", async () => {
    let bodyCancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "Content-Type": "video/mp4" } }
      )) as unknown as typeof fetch;

    const warmed = await warmHlsPath(
      `${TEST_ORIGIN}/api/hls/mislabeled`,
      new AbortController().signal,
      1080,
      50
    );

    expect(warmed).toBe(false);
    expect(bodyCancelled).toBe(true);
  });

  it("bounds and cancels an unknown binary root without a Range request", async () => {
    let pulls = 0;
    let bodyCancelled = false;
    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).has("range")).toBe(false);
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/octet-stream" } }
      );
    }) as unknown as typeof fetch;

    const warmed = await warmHlsPath(
      `${TEST_ORIGIN}/api/hls/unknown-binary`,
      new AbortController().signal,
      1080,
      100
    );

    expect(warmed).toBe(false);
    expect(bodyCancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
  });

  it("times out a never-settling manifest request", async () => {
    let abortObserved = false;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;

    const warmed = await warmHlsPath(
      `${TEST_ORIGIN}/api/hls/hung`,
      new AbortController().signal,
      1080,
      10
    );

    expect(warmed).toBe(false);
    expect(abortObserved).toBe(true);
  });

  it("allows an immediate manifest retry after navigation abort", async () => {
    installWindow();
    let requestCount = 0;
    globalThis.fetch = (async (_input, init) => {
      requestCount += 1;
      if (requestCount > 1) {
        return new Response("#EXTM3U\n#EXTINF:6,\nsegment.ts");
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    prefetchManifestLite("/api/hls/retry?u=opaque", "hls");
    await Promise.resolve();
    abortAllPreresolve();
    prefetchManifestLite("/api/hls/retry?u=opaque", "hls");
    await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

    expect(requestCount).toBe(2);
  });
});
