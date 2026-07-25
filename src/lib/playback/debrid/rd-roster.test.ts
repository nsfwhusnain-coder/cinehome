/// <reference types="bun-types" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { clearMediaValidationCache } from "./media-validation";

/**
 * Real-Debrid RICH ROSTER regression coverage (see index.ts): RD is the
 * fast, high-volume, PRIMARY engine — a title should surface up to 5
 * distinct honestly-tagged sources (best native, up to 3 more native 1080p,
 * best Safari-only 4K). An MKV/HEVC release is KEPT (no longer dropped —
 * see torrentio.ts's module header) and, when it's the top-ranked candidate
 * in its class, wins a slot honestly tagged `container: "mkv"` so the
 * client's `isSourcePlayableHere` (source-quality.ts) can route it through
 * /api/transcode rather than ever claiming it plays natively. Also covers
 * the fast/prefetch path: a cold cache resolves exactly one native pick
 * within its own bounded deadline and backgrounds the rest; a warm cache
 * returns near-instantly with no network.
 *
 * Two boundaries are exercised for real, mirroring the existing conventions
 * in this folder: a genuine local HTTP server (`Bun.serve`, same technique as
 * token-safety.test.ts) stands in for Torrentio's resolve-proxy redirect, so
 * `resolveTokenFreeRedirect`'s actual redirect-follow logic runs unmocked;
 * `@/lib/tmdb` and `./cached-stream` are mocked (same in-memory-map technique
 * as torbox-standalone.test.ts) so no real TMDB call or SQLite DB is needed.
 */

const FAKE_TOKEN = "test-rd-token";
const IMDB = "tt9999999";

const cacheStore = new Map<string, unknown>();
function cacheKey(key: {
  imdbId: string;
  mediaType: string;
  season?: number;
  episode?: number;
  quality: string;
  provider: string;
}): string {
  return `${key.imdbId}|${key.mediaType}|${key.season ?? 0}|${key.episode ?? 0}|${key.quality}|${key.provider}`;
}

mock.module("@/lib/tmdb", () => ({
  tmdb: { externalIds: async () => ({ id: 1, imdb_id: IMDB }) },
}));
mock.module("./cached-stream", () => ({
  getFreshCachedStream: async (key: Parameters<typeof cacheKey>[0]) => cacheStore.get(cacheKey(key)) ?? null,
  invalidateCachedStream: async (key: Parameters<typeof cacheKey>[0]) => {
    cacheStore.delete(cacheKey(key));
  },
  upsertCachedStream: async (key: Parameters<typeof cacheKey>[0], record: unknown) => {
    cacheStore.set(cacheKey(key), { ...(record as object) });
  },
}));

type ResolveFn = typeof import("./index").resolveDebridSources;
type ResolveFastFn = typeof import("./index").resolveFastDebridSources;

const NATIVE_2160_HASH = "a".repeat(40);
const SAFARI_2160_HASH = "b".repeat(40);
const NATIVE_1080_HASHES = ["c".repeat(40), "d".repeat(40), "e".repeat(40)];
const MKV_1080_HASH = "f".repeat(40);
const SMALL_CLIP_HASH = "1".repeat(40);

describe("Real-Debrid roster — full + fast paths", () => {
  const originalFetch = globalThis.fetch;
  const originalRd = process.env.REAL_DEBRID_API_TOKEN;
  const originalTb = process.env.TORBOX_API_KEY;

  let resolveDebridSources: ResolveFn;
  let resolveFastDebridSources: ResolveFastFn;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        const m = pathname.match(/^\/resolve\/realdebrid\/[^/]+\/([^/]+)\/null\/\d+\/.*$/);
        if (m) {
          const hash = (m[1] ?? "").toLowerCase();
          return new Response(null, { status: 302, headers: { Location: `/cdn/${hash}.mp4` } });
        }
        if (pathname.startsWith("/cdn/")) {
          if (req.headers.has("range")) {
            const totalBytes = pathname.includes(SMALL_CLIP_HASH)
              ? 1_184_727
              : 2 * 1024 * 1024 * 1024;
            return new Response(new Uint8Array([0]), {
              status: 206,
              headers: {
                "Content-Range": `bytes 0-0/${totalBytes}`,
                "Content-Length": "1",
              },
            });
          }
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    // Dynamic import AFTER the mock.module calls so index.ts + torrentio.ts
    // bind the mocked tmdb / cached-stream.
    ({ resolveDebridSources, resolveFastDebridSources } = await import("./index"));
  });

  afterAll(() => {
    server.stop(true);
    mock.restore();
  });

  beforeEach(() => {
    process.env.REAL_DEBRID_API_TOKEN = FAKE_TOKEN;
    delete process.env.TORBOX_API_KEY;
    cacheStore.clear();
    clearMediaValidationCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRd === undefined) delete process.env.REAL_DEBRID_API_TOKEN;
    else process.env.REAL_DEBRID_API_TOKEN = originalRd;
    if (originalTb === undefined) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = originalTb;
  });

  function resolveProxyUrl(hash: string, fileIdx: number, filename: string): string {
    return `http://127.0.0.1:${server.port}/resolve/realdebrid/${FAKE_TOKEN}/${hash}/null/${fileIdx}/${filename}`;
  }

  /** Routes Torrentio's JSON endpoint to a synthetic response; everything else (the local resolve-proxy server) goes out over the real loopback fetch. */
  function mockTorrentioStreams(streams: unknown[]): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("torrentio") && url.includes("/stream/")) {
        return new Response(JSON.stringify({ streams }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("download.real-debrid.com") && init?.headers) {
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-0/${2 * 1024 * 1024 * 1024}`,
            "Content-Length": "1",
          },
        });
      }
      return originalFetch(input as never, init);
    }) as unknown as typeof fetch;
  }

  function buildStreams(): unknown[] {
    return [
      {
        title: "Movie.2024.2160p.WEB-DL.H264-GRP\n👤 40 💾 20 GB ⚙️ X",
        infoHash: NATIVE_2160_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(NATIVE_2160_HASH, 0, "movie.2160p.h264.mp4"),
      },
      {
        title: "Movie.2024.2160p.UHD.BluRay.x265.HDR-GRP\n👤 90 💾 40 GB ⚙️ X",
        infoHash: SAFARI_2160_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(SAFARI_2160_HASH, 0, "movie.2160p.hevc.hdr.mp4"),
      },
      ...NATIVE_1080_HASHES.map((hash, i) => ({
        title: `Movie.2024.1080p.WEB-DL.H264-GRP${i}\n👤 ${30 - i * 5} 💾 3 GB ⚙️ X`,
        infoHash: hash,
        fileIdx: 0,
        url: resolveProxyUrl(hash, 0, `movie.1080p.${i}.h264.mp4`),
      })),
      {
        // A genuine MKV (h264-in-mkv, 1080p) with far more seeders than the
        // three native-1080p releases above. It is KEPT by the parser (no
        // longer dropped — torrentio.ts's module header), but MKV forces
        // `compat:"safari"` regardless of codec, so it lands in the
        // "safari-1080" class — a class this roster has NO slot for at all
        // (RD_SLOTS only defines native-2160/safari-2160/native-1080-1/2/3,
        // see index.ts). So it still never wins one of the 5 slots below,
        // but for an honest, unrelated reason (no matching slot exists),
        // never because it was dropped as MKV — see the dedicated MKV/HEVC
        // 4K test further down for a case that DOES win a slot.
        title: "Movie.2024.1080p.BluRay.x264-GRP.mkv\n👤 999 💾 5 GB ⚙️ X",
        infoHash: MKV_1080_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(MKV_1080_HASH, 0, "movie.1080p.mkv"),
      },
    ];
  }

  it("full path: resolves the entire 5-slot roster, honestly tagged, the safari-1080-classed MKV doesn't win a slot (no such slot exists)", async () => {
    mockTorrentioStreams(buildStreams());
    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });

    expect(sources.length).toBe(5);

    const native2160 = sources.filter((s) => s.compat === "native" && s.maxHeight === 2160);
    const safari2160 = sources.filter((s) => s.compat === "safari" && s.maxHeight === 2160);
    const native1080 = sources.filter((s) => s.compat === "native" && s.maxHeight === 1080);
    expect(native2160.length).toBe(1);
    expect(safari2160.length).toBe(1);
    expect(native1080.length).toBe(3);

    // Three DISTINCT native 1080p releases, not the same one three times —
    // the far-higher-seeded MKV release doesn't steal one of these slots
    // (it's a different class: safari-1080, not native-1080).
    expect(new Set(native1080.map((s) => s.url)).size).toBe(3);
    expect(native1080.some((s) => s.url.includes(MKV_1080_HASH))).toBe(false);

    // No slot in this roster is safari-1080, so the MKV candidate doesn't
    // surface here — NOT because it was dropped as MKV (see the dedicated
    // "kept" test below for a class that does have a slot).
    expect(sources.some((s) => s.container === "mkv")).toBe(false);

    // Honest tagging.
    expect(safari2160[0]?.codec).toBe("hevc");
    for (const s of sources) {
      expect(s.origin).toBe("debrid");
      expect(s.type).toBe("mp4");
      expect(s.provider).toBe("Debrid");
    }
  });

  it("full path: duplicate Torrentio hashes cannot occupy separate cold-roster slots", async () => {
    const streams = buildStreams() as Array<Record<string, unknown>>;
    const original = streams.find((stream) => stream.infoHash === NATIVE_1080_HASHES[0]);
    if (original) delete original.infoHash;
    streams.push({
      title: "Movie.2024.1080p.WEB-DL.H264-DUPLICATE\n👤 29 💾 3 GB ⚙️ X",
      fileIdx: 0,
      // Same hash embedded in a different filename/resolve URL, with the
      // explicit infoHash omitted just like the live Torrentio response.
      url: resolveProxyUrl(NATIVE_1080_HASHES[0], 0, "movie.1080p.duplicate.h264.mp4"),
    });
    mockTorrentioStreams(streams);

    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources.length).toBe(5);
    expect(new Set(sources.map((source) => source.url)).size).toBe(5);
  });

  /**
   * The real "kept, not dropped" regression coverage (transcoder-link task):
   * a 4K HEVC-in-MKV release, when it's the top-ranked candidate in a class
   * that DOES have an RD slot (safari-2160), must win that slot — honestly
   * tagged `container: "mkv"` — rather than being dropped or silently
   * displaced by a lower-seeded non-MKV candidate.
   */
  it("full path: a top-ranked 4K MKV/HEVC release wins the safari-2160 slot, honestly tagged container:mkv", async () => {
    const MKV_2160_HASH = "9".repeat(40);
    mockTorrentioStreams([
      {
        title: "Movie.2024.2160p.WEB-DL.H264-GRP\n👤 40 💾 20 GB ⚙️ X",
        infoHash: NATIVE_2160_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(NATIVE_2160_HASH, 0, "movie.2160p.h264.mp4"),
      },
      {
        // Lower-seeded non-MKV Safari-only 4K candidate — should lose the
        // safari-2160 slot to the higher-seeded MKV release below.
        title: "Movie.2024.2160p.UHD.BluRay.x265.HDR-GRP\n👤 90 💾 40 GB ⚙️ X",
        infoHash: SAFARI_2160_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(SAFARI_2160_HASH, 0, "movie.2160p.hevc.hdr.mp4"),
      },
      {
        // Top-seeded 4K HEVC remux, packaged as MKV — must survive selection
        // and win the safari-2160 slot (previously dropped outright).
        title: "Movie.2024.2160p.UHD.BluRay.x265.HDR.mkv\n👤 500 💾 60 GB ⚙️ X",
        infoHash: MKV_2160_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(MKV_2160_HASH, 0, "movie.2160p.hevc.hdr.mkv"),
      },
    ]);

    const sources = await resolveDebridSources({ tmdbId: 2, mediaType: "movie" });
    const safari2160 = sources.filter((s) => s.compat === "safari" && s.maxHeight === 2160);

    expect(safari2160.length).toBe(1);
    expect(safari2160[0]?.url).toContain(MKV_2160_HASH);
    expect(safari2160[0]?.container).toBe("mkv");
    expect(safari2160[0]?.codec).toBe("hevc");
  });

  it("full path: repeat resolve is a pure cache read (zero Torrentio/RD network calls)", async () => {
    mockTorrentioStreams(buildStreams());
    const first = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(first.length).toBe(5);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("should not be called on a warm cache");
    }) as unknown as typeof fetch;

    const second = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(second.length).toBe(5);
    expect(calls).toBe(0);
  });

  it("full path: rejects a resolved short clip and falls through to the next ranked release", async () => {
    const slots = ["native-2160", "safari-2160", "native-1080-2", "native-1080-3"];
    for (const slot of slots) {
      cacheStore.set(`${IMDB}|movie|0|0|${slot}|realdebrid`, {
        title: `Cached ${slot}`,
        source: slot,
        url: `http://127.0.0.1:${server.port}/cdn/cached-${slot}.mp4`,
        compat: slot === "safari-2160" ? "safari" : "native",
      });
    }
    const goodHash = "2".repeat(40);
    mockTorrentioStreams([
      {
        title: "Movie.2024.1080p.WEB-DL.H264.CLIP\n👤 999 💾 1 MB ⚙️ X",
        infoHash: SMALL_CLIP_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(SMALL_CLIP_HASH, 0, "movie.clip.1080p.h264.mp4"),
      },
      {
        title: "Movie.2024.1080p.WEB-DL.H264-GOOD\n👤 50 💾 3 GB ⚙️ X",
        infoHash: goodHash,
        fileIdx: 0,
        url: resolveProxyUrl(goodHash, 0, "movie.1080p.h264.mp4"),
      },
    ]);

    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    const native1080 = sources.find((source) => source.id.endsWith("native-1080-1"));
    expect(native1080?.url).toContain(goodHash);
    expect(native1080?.url).not.toContain(SMALL_CLIP_HASH);
    const cached = cacheStore.get(`${IMDB}|movie|0|0|native-1080-1|realdebrid`) as
      | { url?: string }
      | undefined;
    expect(cached?.url).toContain(goodHash);
  });

  it("full path: treats an implausibly small warm-cache row as missing and replaces it", async () => {
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|realdebrid`, {
      title: "Generic pack that resolved to a 30-second clip",
      source: SMALL_CLIP_HASH,
      url: `http://127.0.0.1:${server.port}/cdn/${SMALL_CLIP_HASH}.mp4`,
      compat: "native",
    });
    mockTorrentioStreams(buildStreams());

    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources.some((source) => source.url.includes(SMALL_CLIP_HASH))).toBe(false);
    const cached = cacheStore.get(`${IMDB}|movie|0|0|native-1080-1|realdebrid`) as
      | { url?: string }
      | undefined;
    expect(cached?.url).not.toContain(SMALL_CLIP_HASH);
    expect(new Set(sources.map((source) => source.url)).size).toBe(sources.length);
  });

  it("full path: invalidates a bad warm row even when no replacement resolves", async () => {
    const key = `${IMDB}|movie|0|0|native-1080-1|realdebrid`;
    cacheStore.set(key, {
      title: "Short clip with no available replacement",
      source: SMALL_CLIP_HASH,
      url: `http://127.0.0.1:${server.port}/cdn/${SMALL_CLIP_HASH}.mp4`,
      compat: "native",
    });
    mockTorrentioStreams([]);

    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources).toEqual([]);
    expect(cacheStore.has(key)).toBe(false);
  });

  it("full path: collapses duplicate warm slots and refills with an unoccupied release", async () => {
    const slots = ["native-2160", "safari-2160", "native-1080-1", "native-1080-2", "native-1080-3"];
    for (const slot of slots) {
      const duplicate1080 = slot === "native-1080-1" || slot === "native-1080-2";
      const url = duplicate1080
        ? `http://127.0.0.1:${server.port}/cdn/${NATIVE_1080_HASHES[0]}.mp4`
        : `http://127.0.0.1:${server.port}/cdn/cached-${slot}.mp4`;
      cacheStore.set(`${IMDB}|movie|0|0|${slot}|realdebrid`, {
        title: `Cached ${slot}`,
        // Legacy rows can contain only the final direct URL, with no hash.
        // The resolver must still reject a newly-resolved candidate that
        // redirects back to this occupied object.
        source: duplicate1080 ? url : slot,
        url,
        compat: slot === "safari-2160" ? "safari" : "native",
      });
    }
    mockTorrentioStreams(buildStreams());

    const sources = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources.length).toBe(5);
    expect(new Set(sources.map((source) => source.url)).size).toBe(5);
    const refilled = cacheStore.get(`${IMDB}|movie|0|0|native-1080-2|realdebrid`) as
      | { source?: string }
      | undefined;
    expect(refilled?.source).not.toBe(NATIVE_1080_HASHES[0]);
  });

  it("fast path: cold cache is CACHE-ONLY — returns [] immediately (no live network in the awaited path), then backgrounds the full roster resolve", async () => {
    mockTorrentioStreams(buildStreams());
    const started = Date.now();
    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    const elapsedMs = Date.now() - started;

    // The whole point of this fix: a cold cache must NEVER spend time on a
    // live Torrentio/RD resolve inside the awaited fast-path call — it
    // returns nothing for THIS request rather than block on network.
    expect(sources).toEqual([]);
    expect(elapsedMs).toBeLessThan(300);

    // The full live roster resolve still happens — entirely in the
    // background (fire-and-forget, not awaited by the fast call itself) —
    // so poll briefly for all 5 slots to land in cache.
    const pollDeadline = Date.now() + 2_000;
    let rdRowCount = 0;
    while (Date.now() < pollDeadline) {
      rdRowCount = Array.from(cacheStore.keys()).filter((k) => k.endsWith("|realdebrid")).length;
      if (rdRowCount >= 5) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rdRowCount).toBe(5);
  });

  it("fast path: warm cache hit returns near-instantly with the cached source, well under the fast deadline", async () => {
    mockTorrentioStreams([]); // background fill (fires regardless of the cache hit) finds nothing further — harmless.
    cacheStore.set(`${IMDB}|movie|0|0|native-2160|realdebrid`, {
      title: "Movie.2024.2160p.WEB-DL.H264-GRP",
      source: NATIVE_2160_HASH,
      url: "https://51.download.real-debrid.com/d/cached4k/movie.mp4",
      compat: "native",
    });

    const started = Date.now();
    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    const elapsedMs = Date.now() - started;

    expect(sources.length).toBe(1);
    expect(sources[0]?.url).toBe("https://51.download.real-debrid.com/d/cached4k/movie.mp4");
    expect(sources[0]?.maxHeight).toBe(2160);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("fast path: no token configured -> [] immediately, no network", async () => {
    delete process.env.REAL_DEBRID_API_TOKEN;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("should never fetch without a token");
    }) as unknown as typeof fetch;

    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources).toEqual([]);
    expect(calls).toBe(0);
  });
});
