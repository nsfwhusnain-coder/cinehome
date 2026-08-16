/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  cinemaosHash,
  cinemaosQualityRank,
  cinemaosStreamLabel,
  isCinemaosRateLimitedWorkerUrl,
  isCinemaosRejectedStreamUrl,
  isCinemaosEnglish,
  parseCinemaosQuality,
  resolveCinemaos,
  sortCinemaosStreams,
  keepCinemaosLanguageLadders,
  groupCinemaosStreamsByLanguage,
  CINEMAOS_MAX_STREAMS,
  CINEMAOS_OUTER_TIMEOUT_MS,
  CINEMAOS_TIMEOUT_MS,
} from "./cinemaos";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CinemaOS worker quarantine", () => {
  it("drops the rate-limited worker DASH fallback but keeps direct MP4 CDNs", () => {
    expect(
      isCinemaosRateLimitedWorkerUrl(
        "https://holly.cinemaos.workers.dev/p/signed"
      )
    ).toBe(true);
    expect(
      isCinemaosRateLimitedWorkerUrl(
        "https://hcdn.hakunaymatata.com/resource/movie"
      )
    ).toBe(false);
    expect(
      isCinemaosRateLimitedWorkerUrl(
        "https://macdn.hakunaymatata.com/resource/movie"
      )
    ).toBe(false);
  });

  it("drops poison hosts before proxy wrapping can hide their identity", () => {
    expect(
      isCinemaosRejectedStreamUrl(
        "https://aqua-vulture-337623.hostingersite.com/video/fight-club.mp4"
      )
    ).toBe(true);
    expect(
      isCinemaosRejectedStreamUrl(
        "https://hcdn.hakunaymatata.com/resource/fight-club.mp4"
      )
    ).toBe(false);
  });
});

describe("cinemaosHash", () => {
  it("matches golden vector for fixed minuteBucket", () => {
    expect(cinemaosHash(550, 0)).toBe("0df7dd43-0");
    expect(cinemaosHash(550, 1)).toBe("78276562-1");
    expect(cinemaosHash(550, 12345)).toBe("530caf60-9ix");
  });

  it("is stable for same input and format /^[0-9a-f]+-[0-9a-z]+$/", () => {
    const a = cinemaosHash(1396, 42_000);
    const b = cinemaosHash(1396, 42_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+-[0-9a-z]+$/);
  });

  it("changes when minuteBucket changes", () => {
    expect(cinemaosHash(550, 100)).not.toBe(cinemaosHash(550, 101));
  });
});

describe("parseCinemaosQuality / quality rank", () => {
  it("parses quality field and name fallback", () => {
    expect(parseCinemaosQuality("720p")).toBe("720p");
    expect(parseCinemaosQuality("1080")).toBe("1080p");
    expect(parseCinemaosQuality("", "AoneRoom (English) 720p [MP4]")).toBe("720p");
    expect(parseCinemaosQuality("")).toBe("auto");
  });

  it("ranks 2160 > 1080 > 720 > 480 > 360", () => {
    expect(cinemaosQualityRank("2160p")).toBeGreaterThan(cinemaosQualityRank("1080p"));
    expect(cinemaosQualityRank("1080p")).toBeGreaterThan(cinemaosQualityRank("720p"));
    expect(cinemaosQualityRank("720p")).toBeGreaterThan(cinemaosQualityRank("480p"));
    expect(cinemaosQualityRank("480p")).toBeGreaterThan(cinemaosQualityRank("360p"));
  });
});

describe("sortCinemaosStreams (prefer English)", () => {
  it("puts English before Hindi and higher quality first within lang", () => {
    const sorted = sortCinemaosStreams([
      {
        name: "AoneRoom (Hindi) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://example.test/hi1080",
      },
      {
        name: "AoneRoom (English) 720p [MP4]",
        title: "Fight Club",
        quality: "720p",
        url: "https://example.test/en720",
      },
      {
        name: "AoneRoom (English) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://example.test/en1080",
      },
      {
        name: "AoneRoom (Arabic) 720p [MP4]",
        title: "Fight Club",
        quality: "720p",
        url: "https://example.test/ar720",
      },
    ]);
    expect(sorted.map((s) => s.url)).toEqual([
      "https://example.test/en1080",
      "https://example.test/en720",
      "https://example.test/hi1080",
      "https://example.test/ar720",
    ]);
  });
});

describe("keepCinemaosLanguageLadders", () => {
  it("keeps the two richest rungs per language and drops the rest", () => {
    const kept = keepCinemaosLanguageLadders([
      {
        name: "AoneRoom (English) 360p [MP4]",
        title: "Fight Club",
        quality: "360p",
        url: "https://example.test/en360",
      },
      {
        name: "AoneRoom (English) 2160p [MP4]",
        title: "Fight Club",
        quality: "2160p",
        url: "https://example.test/en2160",
      },
      {
        name: "AoneRoom (English) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://example.test/en1080",
      },
      {
        name: "AoneRoom (English) 720p [MP4]",
        title: "Fight Club",
        quality: "720p",
        url: "https://example.test/en720",
      },
      {
        name: "AoneRoom (Hindi) 720p [MP4]",
        title: "Fight Club",
        quality: "720p",
        url: "https://example.test/hi720",
      },
      {
        name: "AoneRoom (Hindi) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://example.test/hi1080",
      },
    ]);
    expect(kept.map((s) => s.url)).toEqual([
      "https://example.test/en2160",
      "https://example.test/en1080",
      "https://example.test/hi1080",
      "https://example.test/hi720",
    ]);
  });
});

describe("groupCinemaosStreamsByLanguage", () => {
  it("folds one language into a single ladder, English first", () => {
    const groups = groupCinemaosStreamsByLanguage([
      {
        name: "AoneRoom (Hindi) 720p [MP4]",
        title: "Fight Club",
        quality: "720p",
        url: "https://example.test/hi720",
      },
      {
        name: "AoneRoom (English) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://example.test/en1080",
      },
      {
        name: "AoneRoom (English) 2160p [MP4]",
        title: "Fight Club",
        quality: "2160p",
        url: "https://example.test/en2160",
      },
    ]);
    expect(groups.map((group) => group.key)).toEqual(["EN", "HI"]);
    expect(groups[0]?.streams.map((stream) => stream.url)).toEqual([
      "https://example.test/en2160",
      "https://example.test/en1080",
    ]);
  });
});

describe("cinemaosStreamLabel", () => {
  it("labels best English as Cinema; other English with quality; non-EN with code", () => {
    expect(
      cinemaosStreamLabel(
        {
          name: "AoneRoom (English) 1080p [MP4]",
          title: "Fight Club",
          quality: "1080p",
          url: "u1",
        },
        { isBestEnglish: true }
      )
    ).toBe("Cinema");

    expect(
      cinemaosStreamLabel(
        {
          name: "AoneRoom (English) 720p [MP4]",
          title: "Fight Club",
          quality: "720p",
          url: "u2",
        },
        { isBestEnglish: false }
      )
    ).toBe("Cinema 720p");

    expect(
      cinemaosStreamLabel(
        {
          name: "AoneRoom (Hindi) 1080p [MP4]",
          title: "Fight Club",
          quality: "1080p",
          url: "u3",
        },
        { isBestEnglish: false }
      )
    ).toBe("Cinema HI 1080");
  });

  it("detects English via isCinemaosEnglish", () => {
    expect(isCinemaosEnglish("AoneRoom (English) 720p")).toBe(true);
    expect(isCinemaosEnglish("AoneRoom (Hindi) 1080p")).toBe(false);
  });
});

describe("cinemaos constants", () => {
  it("timeouts and cap are sane", () => {
    expect(CINEMAOS_TIMEOUT_MS).toBe(12_000);
    expect(CINEMAOS_OUTER_TIMEOUT_MS).toBe(14_000);
    expect(CINEMAOS_OUTER_TIMEOUT_MS).toBeGreaterThan(CINEMAOS_TIMEOUT_MS);
    expect(CINEMAOS_MAX_STREAMS).toBe(6);
  });
});

describe("resolveCinemaos outages vs title miss", () => {
  it("returns [] on 200 empty streams (title miss, not an outage)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ streams: [] }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(resolveCinemaos(550, "movie")).resolves.toEqual([]);
  });

  it("throws on HTTP 502", async () => {
    const { ProviderOutageError } = await import("./provider-outage");
    globalThis.fetch = (async () =>
      new Response("down", { status: 502 })) as unknown as typeof fetch;
    await expect(resolveCinemaos(550, "movie")).rejects.toBeInstanceOf(
      ProviderOutageError
    );
  });
});

describe("resolveCinemaos stream declaration", () => {
  it("declares extensionless progressive sources as MP4", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      streams: [{
        name: "AoneRoom (English) 1080p [MP4]",
        title: "Fight Club",
        quality: "1080p",
        url: "https://hcdn.hakunaymatata.com/resource/opaque-token",
      }],
    }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const streams = await resolveCinemaos(550, "movie");

    expect(streams).toHaveLength(1);
    expect(streams[0]?.type).toBe("mp4");
  });
});
