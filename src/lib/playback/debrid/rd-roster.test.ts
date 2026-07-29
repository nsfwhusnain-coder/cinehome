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
 * the fast/prefetch path: a cold trust cache returns immediately with no
 * background work; a short-lived row written only after size + ISO-BMFF proof
 * returns near-instantly with zero network activity.
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
const fastTrustProvider = (tmdbId: number) => `realdebrid-fast-v1:${tmdbId}`;
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
  getTrustedFastCachedStreams: async (input: {
    tmdbId: number;
    mediaType: string;
    season?: number;
    episode?: number;
  }) => {
    const rows: unknown[] = [];
    for (const [key, value] of cacheStore) {
      const [imdbId, mediaType, season, episode, quality, provider] = key.split("|");
      if (
        mediaType === input.mediaType &&
        Number(season) === (input.season ?? 0) &&
        Number(episode) === (input.episode ?? 0) &&
        provider === fastTrustProvider(input.tmdbId)
      ) {
        rows.push({ ...(value as object), imdbId, quality });
      }
    }
    return rows;
  },
  invalidateCachedStream: async (key: Parameters<typeof cacheKey>[0]) => {
    cacheStore.delete(cacheKey(key));
  },
  invalidateTrustedFastCachedStream: async (
    key: Parameters<typeof cacheKey>[0] & { tmdbId: number }
  ) => {
    cacheStore.delete(cacheKey({ ...key, provider: fastTrustProvider(key.tmdbId) }));
  },
  upsertCachedStream: async (key: Parameters<typeof cacheKey>[0], record: unknown) => {
    cacheStore.set(cacheKey(key), { ...(record as object) });
  },
  upsertTrustedFastCachedStream: async (
    key: Parameters<typeof cacheKey>[0] & { tmdbId: number },
    record: unknown
  ) => {
    cacheStore.set(
      cacheKey({ ...key, provider: fastTrustProvider(key.tmdbId) }),
      { ...(record as object) }
    );
  },
}));

type ResolveFn = typeof import("./index").resolveDebridSources;
type ResolveFastFn = typeof import("./index").resolveFastDebridSources;

const NATIVE_2160_HASH = "a".repeat(40);
const SAFARI_2160_HASH = "b".repeat(40);
const NATIVE_1080_HASHES = ["c".repeat(40), "d".repeat(40), "e".repeat(40)];
const MKV_1080_HASH = "f".repeat(40);
const SMALL_CLIP_HASH = "1".repeat(40);
const FALLBACK_720_HASH = "7".repeat(40);
const UNSUPPORTED_CONTAINER_HASH = "8".repeat(40);
const SAFARI_MKV_HASH = "9".repeat(40);

function isoBmffBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  return bytes;
}

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
          const extension =
            hash === UNSUPPORTED_CONTAINER_HASH
              ? "m2ts"
              : hash === SAFARI_MKV_HASH
                ? "mkv"
                : "mp4";
          return new Response(null, {
            status: 302,
            headers: { Location: `/cdn/${hash}.${extension}` },
          });
        }
        if (pathname.startsWith("/cdn/")) {
          if (req.headers.has("range")) {
            const totalBytes = pathname.includes(SMALL_CLIP_HASH)
              ? 1_184_727
              : 2 * 1024 * 1024 * 1024;
            const body = pathname.includes(UNSUPPORTED_CONTAINER_HASH)
              ? new Uint8Array(32)
              : isoBmffBytes();
            return new Response(body, {
              status: 206,
              headers: {
                "Content-Range": `bytes 0-${body.length - 1}/${totalBytes}`,
                "Content-Length": String(body.length),
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
  function mockTorrentioStreams(
    streams: unknown[],
    onTorrentioRequest?: () => void
  ): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("torrentio") && url.includes("/stream/")) {
        onTorrentioRequest?.();
        return new Response(JSON.stringify({ streams }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("download.real-debrid.com") && init?.headers) {
        const body = isoBmffBytes();
        return new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${body.length - 1}/${2 * 1024 * 1024 * 1024}`,
            "Content-Length": String(body.length),
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

  it("full path: preserves native rank order when the first cold candidate fails validation", async () => {
    for (const slot of ["native-2160", "safari-2160"] as const) {
      cacheStore.set(`${IMDB}|movie|0|0|${slot}|realdebrid`, {
        title: `Cached ${slot}`,
        source: slot,
        url: `http://127.0.0.1:${server.port}/cdn/cached-${slot}.mp4`,
        compat: slot === "safari-2160" ? "safari" : "native",
      });
    }
    const rankedGoodHashes = ["2".repeat(40), "3".repeat(40), "4".repeat(40)];
    mockTorrentioStreams([
      {
        title: "Movie.2024.1080p.WEB-DL.H264.BAD.mp4\n👤 999 💾 3 GB",
        infoHash: SMALL_CLIP_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(
          SMALL_CLIP_HASH,
          0,
          "movie.bad.1080p.h264.mp4"
        ),
      },
      ...rankedGoodHashes.map((hash, index) => ({
        title: `Movie.2024.1080p.WEB-DL.H264.GOOD${index}.mp4\n👤 ${
          40 - index * 10
        } 💾 3 GB`,
        infoHash: hash,
        fileIdx: 0,
        url: resolveProxyUrl(hash, 0, `movie.good${index}.1080p.h264.mp4`),
      })),
    ]);

    const sources = await resolveDebridSources({
      tmdbId: 1,
      mediaType: "movie",
    });
    const native1080 = sources
      .filter((source) => source.id.includes("native-1080"))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(native1080).toHaveLength(3);
    expect(native1080.map((source) => source.url)).toEqual(
      rankedGoodHashes.map((hash) =>
        expect.stringContaining(hash)
      )
    );
  });

  /**
   * The real "kept, not dropped" regression coverage (transcoder-link task):
   * a 4K HEVC-in-MKV release, when it's the top-ranked candidate in a class
   * that DOES have an RD slot (safari-2160), must win that slot — honestly
   * tagged `container: "mkv"` — rather than being dropped or silently
   * displaced by a lower-seeded non-MKV candidate.
   */
  it("full path: a top-ranked 4K MKV/HEVC release wins the safari-2160 slot, honestly tagged container:mkv", async () => {
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
        // Top-seeded, streaming-fit 4K HEVC encode packaged as MKV — it must
        // survive selection and win the safari-2160 slot (previously dropped).
        title: "Movie.2024.2160p.UHD.BluRay.x265.HDR.mkv\n👤 500 💾 12 GB ⚙️ X",
        infoHash: SAFARI_MKV_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(SAFARI_MKV_HASH, 0, "movie.2160p.hevc.hdr.mkv"),
      },
    ]);

    const sources = await resolveDebridSources({ tmdbId: 2, mediaType: "movie" });
    const safari2160 = sources.filter((s) => s.compat === "safari" && s.maxHeight === 2160);

    expect(safari2160.length).toBe(1);
    expect(safari2160[0]?.url).toContain(SAFARI_MKV_HASH);
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

  it("full recovery: expires signed RD slots and resolves a fresh roster", async () => {
    mockTorrentioStreams(buildStreams());
    const first = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(first.length).toBe(5);

    let torrentioCalls = 0;
    mockTorrentioStreams(buildStreams(), () => {
      torrentioCalls++;
    });
    const refreshed = await resolveDebridSources({
      tmdbId: 1,
      mediaType: "movie",
      forceRefresh: true,
    });

    expect(torrentioCalls).toBe(1);
    expect(refreshed.length).toBe(5);
  });

  it("full recovery expires the separate fast-trust namespace before resolving", async () => {
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|realdebrid`, {
      title: "Normal cached row",
      source: NATIVE_1080_HASHES[0],
      url: "https://51.download.real-debrid.com/d/cached1080/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|${fastTrustProvider(1)}`, {
      title: "Trusted cached row",
      source: NATIVE_1080_HASHES[0],
      url: "https://51.download.real-debrid.com/d/cached1080/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    mockTorrentioStreams([]);

    const refreshed = await resolveDebridSources({
      tmdbId: 1,
      mediaType: "movie",
      forceRefresh: true,
    });

    expect(refreshed).toEqual([]);
    expect(
      cacheStore.has(`${IMDB}|movie|0|0|native-1080-1|${fastTrustProvider(1)}`)
    ).toBe(false);
  });

  it("fast path: legacy MKV cache URL is classified locally and withheld from native playback", async () => {
    mockTorrentioStreams([]);
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|realdebrid`, {
      title: "Legacy.1080p.H264",
      source: "legacy",
      url: `http://127.0.0.1:${server.port}/cdn/legacy.1080p.h264.mkv`,
      compat: "native",
      codec: "h264",
    });

    const sources = await resolveFastDebridSources({
      tmdbId: 1,
      mediaType: "movie",
    });

    expect(sources).toEqual([]);
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
        // Metadata claims a plausible feature size so the resolver still
        // exercises media validation and falls through after the CDN proves
        // that the object is only a short clip.
        title: "Movie.2024.1080p.WEB-DL.H264.CLIP\nseeders 999 size 3 GB source X",
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

  it("full path: rejects an unknown native container whose signature is M2TS", async () => {
    const slots = [
      "native-2160",
      "safari-2160",
      "native-1080-2",
      "native-1080-3",
    ];
    for (const slot of slots) {
      cacheStore.set(`${IMDB}|movie|0|0|${slot}|realdebrid`, {
        title: `Cached ${slot}`,
        source: slot,
        url: `http://127.0.0.1:${server.port}/cdn/cached-${slot}.mp4`,
        compat: slot === "safari-2160" ? "safari" : "native",
      });
    }
    mockTorrentioStreams([
      {
        title: "Movie.2024.1080p.WEB-DL.H264-UNKNOWN\n👤 50 💾 3 GB",
        infoHash: UNSUPPORTED_CONTAINER_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(
          UNSUPPORTED_CONTAINER_HASH,
          0,
          "movie.unknown.1080p.h264.m2ts"
        ),
      },
    ]);

    const sources = await resolveDebridSources({
      tmdbId: 1,
      mediaType: "movie",
    });

    expect(
      sources.some((source) =>
        source.url.includes(UNSUPPORTED_CONTAINER_HASH)
      )
    ).toBe(false);
    expect(
      cacheStore.has(
        `${IMDB}|movie|0|0|native-1080-1|realdebrid`
      )
    ).toBe(false);
  });

  it("full path: ignores non-cached RD-download rows and uses an instant native 720p availability fallback", async () => {
    mockTorrentioStreams([
      {
        name: "[RD download] Torrentio\n1080p",
        title: "Episode.1080p.H264.mp4\n👤 999 💾 1 GB",
        infoHash: SMALL_CLIP_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(
          SMALL_CLIP_HASH,
          0,
          "episode.not-instant.1080p.h264.mp4"
        ),
      },
      {
        name: "[RD+] Torrentio\n720p",
        title: "Episode.720p.H264.mp4\n👤 20 💾 400 MB",
        infoHash: FALLBACK_720_HASH,
        fileIdx: 0,
        url: resolveProxyUrl(
          FALLBACK_720_HASH,
          0,
          "episode.instant.720p.h264.mp4"
        ),
      },
    ]);

    const sources = await resolveDebridSources({
      tmdbId: 1,
      mediaType: "tv",
      season: 1,
      episode: 1,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id.endsWith("native-720")).toBe(true);
    expect(sources[0]?.quality).toBe("720p");
    expect(sources[0]?.maxHeight).toBe(720);
    expect(sources[0]?.url).toContain(FALLBACK_720_HASH);
    expect(sources[0]?.url).not.toContain(SMALL_CLIP_HASH);
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
        ? `http://127.0.0.1:${server.port}/cdn/legacy-rotated-yify.mp4`
        : `http://127.0.0.1:${server.port}/cdn/cached-${slot}.mp4`;
      cacheStore.set(`${IMDB}|movie|0|0|${slot}|realdebrid`, {
        title: duplicate1080
          ? "Movie.2024.1080p.WEB-DL.H264-GRP0"
          : `Cached ${slot}`,
        // Legacy rows can contain only a now-rotated direct URL, with no hash.
        // The normalized release title must bridge identity to the fresh
        // candidate even though its new redirect target differs.
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

  it("fast path: cold trust cache returns [] with zero network or background work", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fast miss must not fetch");
    }) as unknown as typeof fetch;
    const started = Date.now();
    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    const elapsedMs = Date.now() - started;

    expect(sources).toEqual([]);
    expect(elapsedMs).toBeLessThan(300);
    expect(fetchCalls).toBe(0);
    expect(cacheStore.size).toBe(0);
  });

  it("fast path: returns every trusted native rung near-instantly", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("trusted fast hit must not fetch");
    }) as unknown as typeof fetch;
    cacheStore.set(`${IMDB}|movie|0|0|native-2160|${fastTrustProvider(1)}`, {
      title: "Movie.2024.2160p.WEB-DL.H264-GRP",
      source: NATIVE_2160_HASH,
      url: "https://51.download.real-debrid.com/d/cached4k/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|${fastTrustProvider(1)}`, {
      title: "Movie.2024.1080p.WEB-DL.H264-GRP",
      source: NATIVE_1080_HASHES[0],
      url: "https://51.download.real-debrid.com/d/cached1080/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });

    const started = Date.now();
    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    const elapsedMs = Date.now() - started;

    expect(sources.length).toBe(2);
    expect(sources[0]?.url).toBe("https://51.download.real-debrid.com/d/cached4k/movie.mp4");
    expect(sources[0]?.maxHeight).toBe(2160);
    expect(sources[1]?.maxHeight).toBe(1080);
    expect(elapsedMs).toBeLessThan(500);
    expect(fetchCalls).toBe(0);
  });

  it("fast path: rejects conflicting, unknown-codec, and old-version trust rows locally", async () => {
    cacheStore.set(`${IMDB}|movie|0|0|native-2160|${fastTrustProvider(1)}`, {
      title: "Conflicting container",
      source: NATIVE_2160_HASH,
      url: "https://51.download.real-debrid.com/d/conflict/movie.mkv",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|${fastTrustProvider(1)}`, {
      title: "Unknown codec",
      source: NATIVE_1080_HASHES[0],
      url: "https://51.download.real-debrid.com/d/unknown/movie.mp4",
      compat: "native",
      codec: "unknown",
      container: "mp4",
    });
    cacheStore.set(`${IMDB}|movie|0|0|native-720|realdebrid-fast-v0:1`, {
      title: "Old trust version",
      source: FALLBACK_720_HASH,
      url: "https://51.download.real-debrid.com/d/old/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("rejected trust rows must not fetch");
    }) as unknown as typeof fetch;

    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it("full path writes conclusive native proof for a later zero-network fast hit", async () => {
    mockTorrentioStreams(buildStreams());
    const full = await resolveDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(full.length).toBe(5);
    expect(
      Array.from(cacheStore.keys()).filter((key) =>
        key.endsWith(`|${fastTrustProvider(1)}`)
      ).length
    ).toBe(4);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fast trust read must not fetch");
    }) as unknown as typeof fetch;
    const fast = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(fast.map((source) => source.maxHeight)).toEqual([2160, 1080, 1080, 1080]);
    expect(fetchCalls).toBe(0);
  });

  it("fast path: a trusted native cache hit survives cleared process validation state", async () => {
    clearMediaValidationCache();
    cacheStore.set(`${IMDB}|movie|0|0|native-1080-1|${fastTrustProvider(1)}`, {
      title: "Movie.2024.1080p.WEB-DL.H264-GRP",
      source: NATIVE_1080_HASHES[0],
      url: "https://51.download.real-debrid.com/d/cached1080/movie.mp4",
      compat: "native",
      codec: "h264",
      container: "mp4",
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("process validation cache must be irrelevant");
    }) as unknown as typeof fetch;

    const sources = await resolveFastDebridSources({ tmdbId: 1, mediaType: "movie" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.container).toBe("mp4");
    expect(fetchCalls).toBe(0);
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
