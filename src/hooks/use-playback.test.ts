import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { PlaybackResponse, PlaybackSource } from "@/lib/playback/types";
import {
  mergePlaybackResponses,
  playbackQueryKey,
  recoverPlaybackRoster,
} from "./use-playback";

function source(url: string): PlaybackSource {
  return {
    id: "debrid-slot",
    url,
    provider: "Real-Debrid",
    quality: "1080p",
    label: "1080p",
    type: "mp4",
  };
}

describe("watch playback recovery merge", () => {
  it("does not resurrect a stale fast URL when recovery is temporarily empty", () => {
    const fast: PlaybackResponse = {
      status: "available",
      sources: [source("https://old.invalid/video.mp4")],
    };
    const recovery: PlaybackResponse = {
      status: "error",
      sources: [],
      partial: true,
      refreshNonce: 123,
    };

    const merged = mergePlaybackResponses(fast, recovery, false);

    expect(merged?.sources).toEqual([]);
    expect(merged?.streamUrl).toBeUndefined();
    expect(merged?.refreshNonce).toBe(123);
    expect(merged?.partial).toBe(true);
  });

  it("uses only the refreshed URL when recovery returns the same stable id", () => {
    const fast: PlaybackResponse = {
      status: "available",
      sources: [source("https://old.invalid/video.mp4")],
    };
    const recovery: PlaybackResponse = {
      status: "available",
      sources: [source("https://fresh.invalid/video.mp4")],
      streamUrl: "https://fresh.invalid/video.mp4",
      refreshNonce: 456,
    };

    const merged = mergePlaybackResponses(fast, recovery, false);

    expect(merged?.sources?.map((item) => item.url)).toEqual([
      "https://fresh.invalid/video.mp4",
    ]);
    expect(merged?.streamUrl).toBe("https://fresh.invalid/video.mp4");
  });
});

describe("watch playback recovery transport", () => {
  it("cancels a deferred ordinary full fetch and always starts recovery", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fullKey = playbackQueryKey("movie", 550, undefined, undefined, false);
    let ordinaryAborted = false;
    const ordinary = qc.fetchQuery({
      queryKey: fullKey,
      queryFn: ({ signal }) =>
        new Promise<PlaybackResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              ordinaryAborted = true;
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true }
          );
        }),
    });
    // TanStack owns this expected cancellation; attach a handler immediately
    // so the test runner never observes it as an unhandled rejection.
    void ordinary.catch(() => undefined);

    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          status: "available",
          sources: [source("https://fresh.invalid/video.mp4")],
          refreshNonce: 789,
        } satisfies PlaybackResponse),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const recovered = await recoverPlaybackRoster(qc, {
        mediaType: "movie",
        tmdbId: 550,
      });

      expect(ordinaryAborted).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("refresh=1");
      expect(recovered.refreshNonce).toBe(789);
      expect(qc.getQueryData<PlaybackResponse>(fullKey)).toEqual(recovered);
      expect(
        qc.getQueryData<PlaybackResponse>(
          playbackQueryKey("movie", 550, undefined, undefined, true)
        )
      ).toEqual(recovered);
    } finally {
      globalThis.fetch = originalFetch;
      qc.clear();
    }
  });

  it("keeps recovery mode on a transient 503 retry", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({ error: "upstream unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "available",
          sources: [source("https://retry.invalid/video.mp4")],
          refreshNonce: 790,
        } satisfies PlaybackResponse),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const recovered = await recoverPlaybackRoster(qc, {
        mediaType: "movie",
        tmdbId: 550,
      });

      expect(requests).toHaveLength(2);
      expect(requests.every((url) => url.includes("refresh=1"))).toBe(true);
      expect(recovered.refreshNonce).toBe(790);
    } finally {
      globalThis.fetch = originalFetch;
      qc.clear();
    }
  });
});
