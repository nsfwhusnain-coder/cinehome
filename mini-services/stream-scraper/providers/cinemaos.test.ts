/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  cinemaosHash,
  cinemaosQualityRank,
  cinemaosStreamLabel,
  isCinemaosEnglish,
  parseCinemaosQuality,
  sortCinemaosStreams,
  CINEMAOS_MAX_STREAMS,
  CINEMAOS_OUTER_TIMEOUT_MS,
  CINEMAOS_TIMEOUT_MS,
} from "./cinemaos";

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
