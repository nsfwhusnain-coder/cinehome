/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isTorBoxConfigured,
  checkCachedTorboxHashes,
  resolveTorboxDirectLink,
  TORBOX_POLL_INTERVAL_MS,
} from "./torbox";

/**
 * TorBox client regression coverage. TorBox's real API (base
 * https://api.torbox.app/v1/api — verified against its live OpenAPI spec,
 * see torbox.ts header) is never hit here: `globalThis.fetch` is replaced
 * with a small router keyed by path for the duration of each test and
 * restored afterward. This exercises the shipped
 * checkcached / add / poll / requestdl orchestration, guards, and error
 * handling end-to-end without a live token.
 */

const FAKE_KEY = "test-torbox-key";
const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("torbox — no token configured (dormant, mirrors realdebrid.ts)", () => {
  const original = process.env.TORBOX_API_KEY;

  beforeEach(() => {
    delete process.env.TORBOX_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = original;
  });

  it("isTorBoxConfigured() is false", () => {
    expect(isTorBoxConfigured()).toBe(false);
  });

  it("checkCachedTorboxHashes returns an empty Set without a network call", async () => {
    const result = await checkCachedTorboxHashes([HASH_A]);
    expect(result.size).toBe(0);
  });

  it("resolveTorboxDirectLink returns null without a network call", async () => {
    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 5_000);
    expect(result).toBeNull();
  });
});

describe("torbox — with a fake key, fetch mocked at the boundary", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TORBOX_API_KEY;

  beforeEach(() => {
    process.env.TORBOX_API_KEY = FAKE_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = originalKey;
  });

  it("checkCachedTorboxHashes: only hashes present as keys in `data` are treated as cached", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/torrents/checkcached");
      return jsonResponse({
        success: true,
        data: { [HASH_A]: { name: "Movie", size: 123, hash: HASH_A } },
      });
    }) as typeof fetch;

    const result = await checkCachedTorboxHashes([HASH_A, "b".repeat(40)]);
    expect(result.has(HASH_A)).toBe(true);
    expect(result.size).toBe(1);
  });

  it("checkCachedTorboxHashes: non-success response yields an empty Set, never throws", async () => {
    globalThis.fetch = (async () => jsonResponse({ success: false })) as unknown as typeof fetch;
    const result = await checkCachedTorboxHashes([HASH_A]);
    expect(result.size).toBe(0);
  });

  it("happy path: add -> poll (ready first try) -> requestdl returns a direct URL", async () => {
    let mylistCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: true, data: { torrent_id: 42, hash: HASH_A } });
      }
      if (url.includes("/torrents/mylist")) {
        mylistCalls += 1;
        return jsonResponse({
          success: true,
          data: [
            {
              id: 42,
              hash: HASH_A,
              download_finished: true,
              download_present: true,
              files: [
                { id: 1, name: "sample.txt", size: 100 },
                // .mp4 (not .mkv) so this genuinely exercises the "native" compat
                // path — MKV container alone forces "safari" regardless of codec
                // (see the dedicated HEVC/MKV test below).
                { id: 2, name: "Movie.2024.1080p.WEB-DL.H264-GRP.mp4", size: 5_000_000_000 },
              ],
            },
          ],
        });
      }
      if (url.includes("/torrents/requestdl")) {
        expect(url).toContain(`token=${FAKE_KEY}`);
        expect(url).toContain("file_id=2");
        return jsonResponse({ success: true, data: "https://store.torbox.app/d/xyz/Movie.2024.1080p.mp4" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 10_000);
    expect(result).toEqual({
      url: "https://store.torbox.app/d/xyz/Movie.2024.1080p.mp4",
      fileBytes: 5_000_000_000,
      codec: "h264",
      compat: "native",
    });
    expect(mylistCalls).toBe(1);
  });

  it("HEVC/x265 release name -> codec 'hevc', compat 'safari' (classified from the actual TorBox file)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: true, data: { torrent_id: 11, hash: HASH_A } });
      }
      if (url.includes("/torrents/mylist")) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 11,
              hash: HASH_A,
              download_finished: true,
              files: [{ id: 3, name: "Movie.2024.2160p.UHD.BluRay.x265.HDR.mkv", size: 8_000_000_000 }],
            },
          ],
        });
      }
      if (url.includes("/torrents/requestdl")) {
        return jsonResponse({ success: true, data: "https://store.torbox.app/d/xyz/hevc.mkv" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 10_000);
    expect(result?.codec).toBe("hevc");
    expect(result?.compat).toBe("safari");
  });

  it("skips files over the free-tier 9.5GB guard, picking the largest ELIGIBLE file instead", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: true, data: { torrent_id: 7, hash: HASH_A } });
      }
      if (url.includes("/torrents/mylist")) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 7,
              hash: HASH_A,
              download_finished: true,
              files: [
                // 11GB remux — over the 9.5GB free-tier guard, must be skipped.
                { id: 1, name: "Movie.2024.2160p.REMUX.mkv", size: 11 * 1024 * 1024 * 1024 },
                { id: 2, name: "Movie.2024.1080p.WEB-DL.H264-GRP.mkv", size: 4 * 1024 * 1024 * 1024 },
              ],
            },
          ],
        });
      }
      if (url.includes("/torrents/requestdl")) {
        expect(url).toContain("file_id=2");
        return jsonResponse({ success: true, data: "https://store.torbox.app/d/xyz/1080p.mkv" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 10_000);
    expect(result?.url).toBe("https://store.torbox.app/d/xyz/1080p.mkv");
  });

  it("skips non-browser-playable containers (.avi) even when it's the only/largest file", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: true, data: { torrent_id: 9, hash: HASH_A } });
      }
      if (url.includes("/torrents/mylist")) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 9,
              hash: HASH_A,
              download_finished: true,
              files: [{ id: 1, name: "Movie.2024.avi", size: 1_000_000 }],
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 10_000);
    expect(result).toBeNull();
  });

  it("createtorrent declining to add (not cached after all) returns null without ever polling", async () => {
    let mylistCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: false, detail: "not cached" });
      }
      if (url.includes("/torrents/mylist")) mylistCalled = true;
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 10_000);
    expect(result).toBeNull();
    expect(mylistCalled).toBe(false);
  });

  it("poll budget expiring before the torrent is ready returns null (never blocks past the shared deadline)", async () => {
    let mylistCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/torrents/createtorrent")) {
        return jsonResponse({ success: true, data: { torrent_id: 5, hash: HASH_A } });
      }
      if (url.includes("/torrents/mylist")) {
        mylistCalls += 1;
        // Never finishes — simulates a torrent TorBox never marks ready within budget.
        return jsonResponse({ success: true, data: [{ id: 5, hash: HASH_A, download_finished: false }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Deadline in the near future but comfortably above scheduling jitter:
    // createtorrent + exactly one mylist poll happen, the poll sees "not
    // ready", and the loop's own budget check (now + 3s interval >= deadline)
    // breaks before sleeping — fast test, still exercises the real poll path.
    const deadline = Date.now() + 300;
    const result = await resolveTorboxDirectLink(HASH_A, deadline);
    expect(result).toBeNull();
    expect(mylistCalls).toBeGreaterThanOrEqual(1);
    expect(TORBOX_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("network failure on any call returns null rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch;

    const result = await resolveTorboxDirectLink(HASH_A, Date.now() + 5_000);
    expect(result).toBeNull();
  });
});
