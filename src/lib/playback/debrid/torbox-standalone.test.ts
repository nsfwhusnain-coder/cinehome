/// <reference types="bun-types" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * STANDALONE + QUOTA/latency coverage for the TorBox tier through
 * `resolveDebridSources`. The owner's actual goal is free 1080p via TorBox
 * with NO Real-Debrid configured (and never paying for one), on a free plan
 * that allows only ~10 torrent adds/month — so the two things that MUST hold
 * are: (1) it works with RD absent via Torrentio's un-configured endpoint,
 * and (2) a lookup never burns more than one `createtorrent` per surfaced
 * quality, and a repeat view burns zero (cache hit).
 *
 * Two boundaries are mocked: `globalThis.fetch` (Torrentio + api.torbox.app),
 * and `@/lib/tmdb` (imdb-id resolution — no TMDB network/DB key needed).
 * `./cached-stream` is mocked with a simple in-memory store so the
 * provider-keyed cache behaves deterministically without a SQLite DB (the
 * test env has none). No real API is ever contacted.
 */

const FAKE_KEY = "standalone-torbox-key";
const IMDB = "tt15398776";
const EIGHT_GB = 8 * 1024 * 1024 * 1024;

const H_1080_NATIVE = "a".repeat(40);
const H_1080_HEVC = "b".repeat(40);
const H_4K_NATIVE = "c".repeat(40);

interface Release {
  hash: string;
  torrentId: number;
  name: string;
  size: number;
  url: string;
  /** Torrentio release-title text (drives parseReleaseTitle → resolution/codec/compat). */
  releaseTitle: string;
}

// --- In-memory CachedStream (provider-keyed, no userId — shared across users). ---
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
  tmdb: { externalIds: async () => ({ id: 872585, imdb_id: IMDB }) },
}));
mock.module("./cached-stream", () => ({
  getFreshCachedStream: async (key: Parameters<typeof cacheKey>[0]) => cacheStore.get(cacheKey(key)) ?? null,
  upsertCachedStream: async (key: Parameters<typeof cacheKey>[0], record: unknown) => {
    cacheStore.set(cacheKey(key), { ...(record as object) });
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ResolveFn = typeof import("./index").resolveDebridSources;

describe("torbox — standalone / quota / latency (through resolveDebridSources)", () => {
  const originalFetch = globalThis.fetch;
  const originalRd = process.env.REAL_DEBRID_API_TOKEN;
  const originalTb = process.env.TORBOX_API_KEY;

  let resolveDebridSources: ResolveFn;
  let requested: string[];
  let createtorrentHashes: string[];
  let releases: Release[];

  beforeAll(async () => {
    // Dynamic import AFTER the mock.module calls so index.ts + torrentio.ts
    // bind the mocked tmdb / cached-stream.
    ({ resolveDebridSources } = await import("./index"));
  });

  afterAll(() => {
    mock.restore();
  });

  function byHash(hash: string): Release | undefined {
    return releases.find((r) => r.hash === hash.toLowerCase());
  }
  function byTorrentId(id: number): Release | undefined {
    return releases.find((r) => r.torrentId === id);
  }

  beforeEach(() => {
    delete process.env.REAL_DEBRID_API_TOKEN;
    process.env.TORBOX_API_KEY = FAKE_KEY;
    cacheStore.clear();
    requested = [];
    createtorrentHashes = [];
    // Default: a single cached 1080p H.264 MP4 release.
    releases = [
      {
        hash: H_1080_NATIVE,
        torrentId: 1,
        name: "Oppenheimer.2023.1080p.WEB-DL.H264-GRP.mp4",
        size: EIGHT_GB,
        url: "https://store.torbox.app/d/abc/Oppenheimer.mp4",
        releaseTitle: "Oppenheimer.2023.1080p.WEB-DL.H264-GRP",
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);

      if (url.includes("torrentio") && url.includes("/stream/")) {
        return jsonResponse({
          streams: releases.map((r) => ({
            name: "Torrentio",
            title: `${r.releaseTitle}\n👤 50 💾 8 GB ⚙️ X`,
            infoHash: r.hash,
            fileIdx: 0,
            behaviorHints: { filename: r.name },
          })),
        });
      }
      if (url.includes("api.torbox.app") && url.includes("/checkcached")) {
        const data: Record<string, unknown> = {};
        for (const r of releases) data[r.hash] = { name: r.name, size: r.size, hash: r.hash };
        return jsonResponse({ success: true, data });
      }
      if (url.includes("api.torbox.app") && url.includes("/createtorrent")) {
        const magnet = String((init?.body as FormData | undefined)?.get("magnet") ?? "");
        const m = magnet.match(/btih:([0-9a-z]+)/i);
        const hash = (m?.[1] ?? "").toLowerCase();
        const rel = byHash(hash);
        if (!rel) return jsonResponse({ success: false });
        createtorrentHashes.push(hash);
        return jsonResponse({ success: true, data: { torrent_id: rel.torrentId, hash } });
      }
      if (url.includes("api.torbox.app") && url.includes("/mylist")) {
        const id = Number(new URL(url).searchParams.get("id"));
        const rel = byTorrentId(id);
        if (!rel) return jsonResponse({ success: false });
        return jsonResponse({
          success: true,
          data: [{ id, hash: rel.hash, download_finished: true, files: [{ id: 0, name: rel.name, size: rel.size }] }],
        });
      }
      if (url.includes("api.torbox.app") && url.includes("/requestdl")) {
        const id = Number(new URL(url).searchParams.get("torrent_id"));
        const rel = byTorrentId(id);
        return rel ? jsonResponse({ success: true, data: rel.url }) : jsonResponse({ success: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRd === undefined) delete process.env.REAL_DEBRID_API_TOKEN;
    else process.env.REAL_DEBRID_API_TOKEN = originalRd;
    if (originalTb === undefined) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = originalTb;
  });

  it("produces a TorBox source via the un-configured Torrentio path with NO RD token", async () => {
    const sources = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    const torbox = sources.find((s) => s.provider === "TorBox");
    expect(torbox).toBeDefined();
    expect(torbox?.origin).toBe("debrid");
    expect(torbox?.quality).toBe("1080p");
    expect(torbox?.url).toBe("https://store.torbox.app/d/abc/Oppenheimer.mp4");
    expect(sources.some((s) => s.provider === "Debrid")).toBe(false);
  });

  it("uses the no-debrid Torrentio endpoint (no /realdebrid= segment, no TorBox key in the URL)", async () => {
    await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    const torrentioReqs = requested.filter((u) => u.includes("torrentio"));
    expect(torrentioReqs.length).toBeGreaterThan(0);
    for (const u of torrentioReqs) {
      expect(u).not.toContain("/realdebrid=");
      expect(u).not.toContain(FAKE_KEY);
    }
  });

  it("the TorBox key only ever appears in requests to api.torbox.app, never any other host", async () => {
    await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    const keyBearing = requested.filter((u) => u.includes(FAKE_KEY));
    expect(keyBearing.length).toBeGreaterThan(0);
    for (const u of keyBearing) {
      expect(u.includes("api.torbox.app")).toBe(true);
    }
  });

  it("the returned TorBox url is the token-free CDN link, never the requestdl URL", async () => {
    const sources = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    const torbox = sources.find((s) => s.provider === "TorBox");
    expect(torbox?.url ?? "").not.toContain(FAKE_KEY);
    expect(torbox?.url ?? "").not.toContain("/requestdl");
  });

  it("QUOTA: a title with multiple cached releases adds AT MOST one torrent per surfaced quality", async () => {
    // Two cached 1080p releases (native H.264 + HEVC) and one cached 4K — the
    // 1080p tier must add ONLY the native winner (never the HEVC one), and the
    // 4K tier adds its one release: two adds total, never three.
    releases = [
      {
        hash: H_1080_HEVC,
        torrentId: 2,
        name: "Movie.2023.1080p.BluRay.x265.mkv",
        size: 7 * 1024 * 1024 * 1024,
        url: "https://store.torbox.app/d/hevc/movie.mkv",
        releaseTitle: "Movie.2023.1080p.BluRay.x265-GRP",
      },
      {
        hash: H_1080_NATIVE,
        torrentId: 1,
        name: "Movie.2023.1080p.WEB-DL.H264-GRP.mp4",
        size: EIGHT_GB,
        url: "https://store.torbox.app/d/h264/movie.mp4",
        releaseTitle: "Movie.2023.1080p.WEB-DL.H264-GRP",
      },
      {
        hash: H_4K_NATIVE,
        torrentId: 3,
        name: "Movie.2023.2160p.WEB-DL.H264-GRP.mp4",
        size: 9 * 1024 * 1024 * 1024,
        url: "https://store.torbox.app/d/4k/movie.mp4",
        releaseTitle: "Movie.2023.2160p.WEB-DL.H264-GRP",
      },
    ];

    const sources = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });

    // At most one add per surfaced quality (here: 1080p + 4K => 2), and the
    // HEVC 1080p release is NEVER added (native won the 1080p rank).
    expect(createtorrentHashes.length).toBe(2);
    expect(createtorrentHashes).toContain(H_1080_NATIVE);
    expect(createtorrentHashes).toContain(H_4K_NATIVE);
    expect(createtorrentHashes).not.toContain(H_1080_HEVC);

    const torbox1080 = sources.find((s) => s.provider === "TorBox" && s.quality === "1080p");
    expect(torbox1080?.url).toBe("https://store.torbox.app/d/h264/movie.mp4");
    expect(sources.some((s) => s.provider === "TorBox" && s.quality === "2160p")).toBe(true);
  });

  it("QUOTA: a repeat resolve of the same title hits the cache and adds ZERO torrents", async () => {
    // Both a 1080p and a 4K release cached, so the first resolve fills the
    // cache for both quality tiers.
    releases = [
      {
        hash: H_1080_NATIVE,
        torrentId: 1,
        name: "Movie.2023.1080p.WEB-DL.H264-GRP.mp4",
        size: EIGHT_GB,
        url: "https://store.torbox.app/d/h264/movie.mp4",
        releaseTitle: "Movie.2023.1080p.WEB-DL.H264-GRP",
      },
      {
        hash: H_4K_NATIVE,
        torrentId: 3,
        name: "Movie.2023.2160p.WEB-DL.H264-GRP.mp4",
        size: 9 * 1024 * 1024 * 1024,
        url: "https://store.torbox.app/d/4k/movie.mp4",
        releaseTitle: "Movie.2023.2160p.WEB-DL.H264-GRP",
      },
    ];

    const first = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    expect(first.filter((s) => s.provider === "TorBox").length).toBe(2);
    expect(createtorrentHashes.length).toBe(2); // one add per surfaced quality

    // Second resolve (a re-watch, or a DIFFERENT user — the cache key has no
    // userId) must serve from cache: zero createtorrent, and it never even
    // needs to hit Torrentio/checkcached again.
    createtorrentHashes = [];
    requested = [];
    const second = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });

    expect(createtorrentHashes.length).toBe(0);
    expect(requested.length).toBe(0);
    expect(second.filter((s) => s.provider === "TorBox").length).toBe(2);
    expect(second.find((s) => s.quality === "1080p")?.url).toBe("https://store.torbox.app/d/h264/movie.mp4");
  });
});
