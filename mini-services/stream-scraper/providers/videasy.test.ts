/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  decryptVideasyPayload,
  encryptVideasyPayload,
} from "./videasy-crypto";
import {
  buildVideasySourceUrl,
  detectVideasyStreamType,
  parseVideasyQuality,
  resolveVideasy,
  throwIfVideasyEmptyOutage,
  videasyQualityRank,
  videasyStreamLabel,
  VIDEASY_SERVERS,
  VIDEASY_MAX_STREAMS,
  VIDEASY_OUTER_TIMEOUT_MS,
  VIDEASY_TIMEOUT_MS,
} from "./videasy";
import { ProviderOutageError } from "./provider-outage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("videasy crypto", () => {
  it("round-trips JSON through enc=2", () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const mediaId = 61838;
    const json = JSON.stringify({
      sources: [{ url: "https://mbph.ironwallnet.net/mp4/abc", quality: "1080p" }],
    });
    const blob = encryptVideasyPayload(json, seed, mediaId);
    expect(decryptVideasyPayload(blob, seed, mediaId)).toBe(json);
  });

  it("rejects a tampered payload", () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const blob = encryptVideasyPayload("{}", seed, 61838);
    expect(() => decryptVideasyPayload(blob, "wrong-seed", 61838)).toThrow(/decrypt failed/);
  });
});

describe("videasy helpers", () => {
  it("parses and ranks quality tokens", () => {
    expect(parseVideasyQuality("1080p")).toBe("1080p");
    expect(parseVideasyQuality("1080")).toBe("1080p");
    expect(parseVideasyQuality("auto")).toBe("auto");
    expect(videasyQualityRank("1080p")).toBeGreaterThan(videasyQualityRank("720p"));
    expect(videasyQualityRank("720p")).toBeGreaterThan(videasyQualityRank("480p"));
  });

  it("reads marketing 4K tokens as 2160, not height 4", () => {
    expect(parseVideasyQuality("4K")).toBe("2160p");
    expect(parseVideasyQuality("4k")).toBe("2160p");
    expect(parseVideasyQuality("UHD")).toBe("2160p");
    expect(parseVideasyQuality("2160")).toBe("2160p");
    expect(videasyQualityRank("4K")).toBeGreaterThan(videasyQualityRank("1080p"));
    expect(videasyQualityRank("4K")).toBe(videasyQualityRank("2160p"));
  });

  it("labels the best rung Quasar and the rest Quasar {height}", () => {
    expect(videasyStreamLabel("1080p", true)).toBe("Quasar");
    expect(videasyStreamLabel("720p", false)).toBe("Quasar 720p");
  });

  it("detects mp4 / hls / dash from url or type", () => {
    expect(detectVideasyStreamType("https://cdn.example/a.mp4")).toBe("mp4");
    expect(detectVideasyStreamType("https://cdn.example/a.m3u8")).toBe("hls");
    expect(detectVideasyStreamType("https://cdn.example/a", "dash")).toBe("dash");
  });

  it("builds Cypher URLs with enc=2 + seed + episode ids", () => {
    const url = buildVideasySourceUrl(VIDEASY_SERVERS[0]!, {
      title: "Barbie: Life in the Dreamhouse",
      mediaType: "tv",
      year: "2012",
      tmdbId: 61838,
      imdbId: "tt2644032",
      seed: "seed.token",
      season: 1,
      episode: 2,
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/downloader2/sources-with-title");
    expect(parsed.searchParams.get("enc")).toBe("2");
    expect(parsed.searchParams.get("seed")).toBe("seed.token");
    expect(parsed.searchParams.get("tmdbId")).toBe("61838");
    expect(parsed.searchParams.get("seasonId")).toBe("1");
    expect(parsed.searchParams.get("episodeId")).toBe("2");
    expect(parsed.searchParams.get("imdbId")).toBe("tt2644032");
  });

  it("caps the exported ladder size", () => {
    expect(VIDEASY_MAX_STREAMS).toBe(6);
    expect(VIDEASY_SERVERS.map((s) => s.name)).toEqual(["Cypher", "Yoru"]);
  });

  it("gives Yoru time to finish after seed + meta instead of aborting at 14s", () => {
    expect(VIDEASY_OUTER_TIMEOUT_MS).toBeGreaterThanOrEqual(28_000);
    expect(VIDEASY_OUTER_TIMEOUT_MS).toBeGreaterThan(VIDEASY_TIMEOUT_MS + 8_000);
  });
});

describe("resolveVideasy", () => {
  it("decrypts Cypher and returns 1080-first Quasar rungs", async () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const mediaId = 61838;
    const blob = encryptVideasyPayload(
      JSON.stringify({
        sources: [
          { url: "https://mbph.ironwallnet.net/mp4/q480", quality: "480p" },
          { url: "https://mbph.ironwallnet.net/mp4/q1080", quality: "1080p" },
          { url: "https://mbph.ironwallnet.net/mp4/q720", quality: "720p" },
        ],
      }),
      seed,
      mediaId
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.includes("/seed?")) {
        return new Response(JSON.stringify({ seed, ttlMs: 30_000 }), { status: 200 });
      }
      if (href.includes("db.speedracelight.com")) {
        return new Response(
          JSON.stringify({
            name: "Barbie: Life in the Dreamhouse",
            first_air_date: "2012-05-01",
            external_ids: { imdb_id: "tt2644032" },
          }),
          { status: 200 }
        );
      }
      if (href.includes("downloader2/sources-with-title")) {
        return new Response(blob, { status: 200 });
      }
      if (href.includes("cdn/sources-with-title")) {
        return new Response(JSON.stringify({ error: "none" }), { status: 500 });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;

    const streams = await resolveVideasy(61838, "tv", 1, 1);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.quality).toBe("1080p");
    expect(streams[0]?.label).toBe("Quasar");
    expect(streams[0]?.provider).toBe("Videasy");
    expect(streams[0]?.type).toBe("mp4");
    expect(streams[0]?.referer).toBe("https://www.vidking.net/");
    expect(streams[0]?.url).toContain("/mp4/q1080");
    expect(streams[0]?.qualityRungs?.map((rung) => rung.height)).toEqual([
      1080, 720, 480,
    ]);
  });

  it("keeps a Yoru 4K HLS rung that Cypher only labelled as 4K", async () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const mediaId = 346698;
    const cypher = encryptVideasyPayload(
      JSON.stringify({
        sources: [{ url: "https://cdn.example/barbie-1080.mp4", quality: "1080p" }],
      }),
      seed,
      mediaId
    );
    const yoru = encryptVideasyPayload(
      JSON.stringify({
        sources: [
          { url: "https://cdn.example/barbie-4k.m3u8", quality: "4K", type: "hls" },
          { url: "https://cdn.example/barbie-1080.m3u8", quality: "1080p", type: "hls" },
        ],
      }),
      seed,
      mediaId
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.includes("/seed?")) {
        return new Response(JSON.stringify({ seed }), { status: 200 });
      }
      if (href.includes("db.speedracelight.com")) {
        return new Response(
          JSON.stringify({
            title: "Barbie",
            release_date: "2023-07-21",
            external_ids: { imdb_id: "tt1517268" },
          }),
          { status: 200 }
        );
      }
      if (href.includes("downloader2/sources-with-title")) {
        return new Response(cypher, { status: 200 });
      }
      if (href.includes("cdn/sources-with-title")) {
        return new Response(yoru, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;

    const streams = await resolveVideasy(346698, "movie");
    expect(streams).toHaveLength(2);
    expect(streams[0]?.quality).toBe("2160p");
    expect(streams[0]?.maxHeight).toBe(2160);
    expect(streams[0]?.label).toBe("Quasar");
    expect(streams[0]?.url).toContain("barbie-4k.m3u8");
    expect(streams[0]?.type).toBe("hls");
    expect(streams[1]?.maxHeight).toBe(1080);
    expect(streams[1]?.label).toBe("Quasar 2");
    expect(streams[0]?.qualityRungs?.map((rung) => rung.height)).toContain(2160);
    expect(streams[0]?.qualityRungs?.map((rung) => rung.height)).not.toContain(4);
  });

  it("retries Yoru when the first pass only has Cypher 1080", async () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const mediaId = 550;
    const cypher = encryptVideasyPayload(
      JSON.stringify({
        sources: [{ url: "https://cdn.example/fc-1080.mp4", quality: "1080p" }],
      }),
      seed,
      mediaId
    );
    const yoru = encryptVideasyPayload(
      JSON.stringify({
        sources: [{ url: "https://cdn.example/fc-4k.m3u8", quality: "4K", type: "hls" }],
      }),
      seed,
      mediaId
    );
    let yoruHits = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.includes("/seed?")) {
        return new Response(JSON.stringify({ seed }), { status: 200 });
      }
      if (href.includes("db.speedracelight.com")) {
        return new Response(
          JSON.stringify({
            title: "Fight Club",
            release_date: "1999-10-15",
            external_ids: { imdb_id: "tt0137523" },
          }),
          { status: 200 }
        );
      }
      if (href.includes("downloader2/sources-with-title")) {
        return new Response(cypher, { status: 200 });
      }
      if (href.includes("cdn/sources-with-title")) {
        yoruHits += 1;
        if (yoruHits === 1) {
          return new Response(JSON.stringify({ error: "none" }), { status: 500 });
        }
        return new Response(yoru, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;

    const streams = await resolveVideasy(550, "movie");
    expect(yoruHits).toBe(2);
    expect(streams[0]?.quality).toBe("2160p");
    expect(streams[0]?.url).toContain("fc-4k.m3u8");
  });

  it("returns empty on a 404 seed miss instead of throwing", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(resolveVideasy(61838, "tv", 1, 1)).resolves.toEqual([]);
  });

  it("throws on seed HTTP 503 (real outage)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(resolveVideasy(61838, "tv", 1, 1)).rejects.toBeInstanceOf(
      ProviderOutageError
    );
  });

  it("treats 200-empty + sibling 429 as an outage, not a title miss", async () => {
    const seed = "59556143.vB6Gja40kUFU91w_z_KVWX";
    const mediaId = 61838;
    const empty = encryptVideasyPayload(JSON.stringify({ sources: [] }), seed, mediaId);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.includes("/seed?")) {
        return new Response(JSON.stringify({ seed }), { status: 200 });
      }
      if (href.includes("db.speedracelight.com")) {
        return new Response(
          JSON.stringify({
            name: "Barbie: Life in the Dreamhouse",
            first_air_date: "2012-05-01",
            external_ids: { imdb_id: "tt2644032" },
          }),
          { status: 200 }
        );
      }
      if (href.includes("downloader2/sources-with-title")) {
        return new Response(empty, { status: 200 });
      }
      if (href.includes("cdn/sources-with-title")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(resolveVideasy(61838, "tv", 1, 1)).rejects.toBeInstanceOf(
      ProviderOutageError
    );
    expect(() =>
      throwIfVideasyEmptyOutage(0, new ProviderOutageError("videasy_http_429", "http_5xx", 429))
    ).toThrow(ProviderOutageError);
    expect(() => throwIfVideasyEmptyOutage(0, null)).not.toThrow();
    expect(() =>
      throwIfVideasyEmptyOutage(1, new ProviderOutageError("videasy_http_429", "http_5xx", 429))
    ).not.toThrow();
  });
});
