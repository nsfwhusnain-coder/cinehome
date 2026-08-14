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
  videasyQualityRank,
  videasyStreamLabel,
  VIDEASY_SERVERS,
  VIDEASY_MAX_STREAMS,
} from "./videasy";

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
    }) as typeof fetch;

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

  it("returns empty on seed miss instead of throwing", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(resolveVideasy(61838, "tv", 1, 1)).resolves.toEqual([]);
  });
});
