/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  extractInfoHashFromResolveUrl,
  fetchTorrentioCandidates,
  isBrowserPlayableContainer,
  isEligibleDebridQuality,
  parseReleaseTitle,
  parseSeeders,
  parseSizeBytes,
} from "./torrentio";

describe("extractInfoHashFromResolveUrl", () => {
  it("recovers the stable hash without returning the credential segment", () => {
    const hash = "a".repeat(40);
    expect(
      extractInfoHashFromResolveUrl(
        `https://torrentio.strem.fun/resolve/realdebrid/SECRET/${hash}/null/0/movie.mp4`
      )
    ).toBe(hash);
  });

  it("does not guess from unrelated or malformed URLs", () => {
    expect(extractInfoHashFromResolveUrl("https://example.com/not-a-resolve/aabb")).toBeUndefined();
    expect(extractInfoHashFromResolveUrl("not a url")).toBeUndefined();
  });
});

/**
 * Real sample release-name conventions (as seen in actual Torrentio/scene
 * release titles) — regression coverage for the classifier that decides
 * quality/codec/HDR/container/browser-compat for the PREMIUM debrid tier.
 */
describe("parseReleaseTitle", () => {
  it("4K HEVC HDR/DV remux -> 2160p, hevc, hdr, safari-only", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.UHD.BluRay.x265.HDR.DV-GROUP");
    expect(r.resolutionHeight).toBe(2160);
    expect(r.codec).toBe("hevc");
    expect(r.hdr).toBe(true);
    expect(r.compat).toBe("safari");
  });

  it("1080p WEB-DL H264 -> 1080p, h264, no hdr, native (Chrome-safe)", () => {
    const r = parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP");
    expect(r.resolutionHeight).toBe(1080);
    expect(r.codec).toBe("h264");
    expect(r.hdr).toBe(false);
    expect(r.compat).toBe("native");
  });

  it("4K WEB-DL H264 -> 2160p, h264, native (Chrome-safe 4K)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.H264-GRP");
    expect(r.resolutionHeight).toBe(2160);
    expect(r.codec).toBe("h264");
    expect(r.hdr).toBe(false);
    expect(r.compat).toBe("native");
  });

  it("1080p BluRay x265 .mkv -> 1080p, hevc, mkv container, safari-only", () => {
    const r = parseReleaseTitle("Movie.2024.1080p.BluRay.x265.mkv");
    expect(r.resolutionHeight).toBe(1080);
    expect(r.codec).toBe("hevc");
    expect(r.container).toBe("mkv");
    expect(r.compat).toBe("safari");
  });

  it("720p release -> resolution detected and retained as an availability fallback", () => {
    const r = parseReleaseTitle("Movie.2024.720p.WEBRip.x264-GRP");
    expect(r.resolutionHeight).toBe(720);
    expect(isEligibleDebridQuality(r.resolutionHeight)).toBe(true);
  });

  it("AV1-in-MP4/WEB-DL -> codec av1, compat NATIVE (Chrome/Firefox-native; Safari support is recent/partial — the opposite situation from HEVC)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1-GRP");
    expect(r.codec).toBe("av1");
    expect(r.compat).toBe("native");
  });

  it("AV1 + HDR -> still safari (HDR forces safari regardless of codec)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1.HDR-GRP");
    expect(r.codec).toBe("av1");
    expect(r.hdr).toBe(true);
    expect(r.compat).toBe("safari");
  });

  it("AV1 + MKV -> still safari at the compat layer (MKV forces safari for TorBox's own file-eligibility use; the actual browser-playability gate is `isBrowserPlayableContainer`, which drops it entirely)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.WEB-DL.AV1.mkv");
    expect(r.codec).toBe("av1");
    expect(r.compat).toBe("safari");
  });

  it("no resolution token -> resolutionHeight null, not eligible", () => {
    const r = parseReleaseTitle("Movie.2024.WEBRip.x264-GRP");
    expect(r.resolutionHeight).toBeNull();
    expect(isEligibleDebridQuality(r.resolutionHeight)).toBe(false);
  });
});

describe("isEligibleDebridQuality", () => {
  it("accepts 720, 1080, and 2160", () => {
    expect(isEligibleDebridQuality(1080)).toBe(true);
    expect(isEligibleDebridQuality(2160)).toBe(true);
    expect(isEligibleDebridQuality(720)).toBe(true);
    expect(isEligibleDebridQuality(480)).toBe(false);
    expect(isEligibleDebridQuality(null)).toBe(false);
  });
});

/**
 * Container detection regression coverage — the honesty fix this tier is
 * built around. LIVE DATA confirms many 4K releases are untagged REMUX
 * (near-universally MKV in practice) rather than literally saying ".mkv".
 */
describe("parseReleaseTitle — container detection", () => {
  it("explicit .mkv token -> container mkv", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.BluRay.x264.mkv").container).toBe("mkv");
  });

  it("explicit mp4 token -> container mp4", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP.mp4").container).toBe("mp4");
  });

  it("webm token -> container webm", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.VP9.webm").container).toBe("webm");
  });

  it("mov token -> container mov", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264.mov").container).toBe("mov");
  });

  it("REMUX with no explicit container token -> inferred mkv (real-world convention)", () => {
    const r = parseReleaseTitle("Movie.2024.2160p.UHD.BluRay.REMUX.DTS-HD.MA-GROUP");
    expect(r.container).toBe("mkv");
  });

  it("no container/remux token at all -> unknown (never fabricated)", () => {
    expect(parseReleaseTitle("Movie.2024.1080p.WEB-DL.H264-GRP").container).toBe("unknown");
  });
});

describe("isBrowserPlayableContainer — the absolute NATIVE browser-playability gate (no longer a drop filter — consumed by source-quality.ts's isSourcePlayableHere to decide native vs. /api/transcode)", () => {
  it("mp4/mov/unknown are eligible", () => {
    expect(isBrowserPlayableContainer("mp4")).toBe(true);
    expect(isBrowserPlayableContainer("mov")).toBe(true);
    expect(isBrowserPlayableContainer("unknown")).toBe(true);
  });

  it("mkv/webm are NEVER eligible — no browser, including Safari, plays them", () => {
    expect(isBrowserPlayableContainer("mkv")).toBe(false);
    expect(isBrowserPlayableContainer("webm")).toBe(false);
  });
});

describe("parseSeeders", () => {
  it("parses the 👤 N seeders footer Torrentio appends", () => {
    expect(parseSeeders("Movie.2024.1080p.WEB-DL.H264-GRP\n👤 137 💾 4.2 GB ⚙️ YTS")).toBe(137);
  });

  it("returns 0 when the footer is absent, never throws", () => {
    expect(parseSeeders("Movie.2024.1080p.WEB-DL.H264-GRP")).toBe(0);
    expect(parseSeeders("")).toBe(0);
  });
});

describe("parseSizeBytes", () => {
  it("parses decimal GB and integer MB Torrentio footers", () => {
    expect(parseSizeBytes("Release\nseeders 2 size 1.68 GB source X")).toBe(
      Math.round(1.68 * 1024 ** 3)
    );
    expect(parseSizeBytes("Release 401 MB")).toBe(401 * 1024 ** 2);
  });

  it("returns null for missing, zero, or malformed sizes", () => {
    expect(parseSizeBytes("Release without a size")).toBeNull();
    expect(parseSizeBytes("Release 0 GB")).toBeNull();
    expect(parseSizeBytes("Release many GB")).toBeNull();
  });
});

/**
 * Candidate pool stratification — the actual fix for the "top 8 by
 * resolution can miss every browser-safe release" gap. Mocks `fetch` at the
 * boundary (Torrentio's JSON endpoint only) so this exercises the real
 * `fetchTorrentioCandidates` -> parse -> filter -> per-class rank/cap path
 * end-to-end, following the same boundary-mocking convention used by
 * torbox.test.ts / torbox-standalone.test.ts elsewhere in this folder.
 */
describe("fetchTorrentioCandidates — MKV/HEVC kept (transcoder-link) + per-class stratification", () => {
  const originalFetch = globalThis.fetch;
  const FAKE_TOKEN = "test-rd-token";

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("prefers a balanced movie encode over an oversized peer and a mislabeled capture", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.WEB-DL.H264.mp4\n👤 5 💾 3 GB",
            infoHash: "b".repeat(40),
          },
          {
            title: "Movie.2024.1080p.BluRay.H264.mp4\n👤 9999 💾 8 GB",
            infoHash: "h".repeat(40),
          },
          {
            title: "Movie.2024.1080p.HD-TS.H264.mp4\n👤 9999 💾 3 GB",
            infoHash: "t".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000005",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "b".repeat(40),
      "h".repeat(40),
      "t".repeat(40),
    ]);
  });

  it("drops explicit RD-download rows but retains an instant native 720p fallback", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            name: "[RD download] Torrentio\n1080p",
            title: "Not.Instant.1080p.H264.mp4",
            infoHash: "d".repeat(40),
          },
          {
            name: "[RD+] Torrentio\n720p",
            title: "Instant.Fallback.720p.H264.mp4",
            infoHash: "f".repeat(40),
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000004",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    expect(candidates.map((candidate) => candidate.infoHash)).toEqual([
      "f".repeat(40),
    ]);
    expect(candidates[0]?.resolutionHeight).toBe(720);
  });

  /**
   * The MKV drop was removed (see torrentio.ts module header): the
   * in-container transcoder now handles anything a browser can't decode/
   * demux directly, so an MKV/HEVC candidate must survive selection with
   * its real `container`/`codec` intact — dropping it would silently lose a
   * real (often the BEST) release rather than routing it through
   * /api/transcode.
   */
  it("keeps an MKV/HEVC 4K release — top of its class by seeders, container/codec preserved for the client's transcode gate", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            // Top-seeded 4K release by a wide margin, and MKV — must now
            // survive (previously dropped outright).
            title: "Movie.2024.2160p.UHD.BluRay.x265.HDR.mkv\n👤 900 💾 40 GB ⚙️ X",
            infoHash: "m".repeat(40),
            fileIdx: 0,
          },
          {
            title: "Movie.2024.1080p.WEB-DL.H264-GRP.mp4\n👤 20 💾 2 GB ⚙️ X",
            infoHash: "n".repeat(40),
            fileIdx: 0,
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000001",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const mkv = candidates.find((c) => c.infoHash === "m".repeat(40));
    expect(mkv).toBeDefined();
    expect(mkv?.container).toBe("mkv");
    expect(mkv?.codec).toBe("hevc");
    expect(mkv?.compat).toBe("safari");
    // The plain H.264/MP4 1080p release still survives too — kept, not displaced.
    expect(candidates.some((c) => c.infoHash === "n".repeat(40))).toBe(true);
  });

  it("keeps a plain H.264-in-MKV 1080p release with its container intact (isBrowserPlayableContainer/isSourcePlayableHere decide honesty downstream, not this parser)", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        streams: [
          {
            title: "Movie.2024.1080p.BluRay.x264.mkv\n👤 50 💾 3 GB ⚙️ X",
            infoHash: "p".repeat(40),
            fileIdx: 0,
          },
        ],
      })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000003",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const mkvH264 = candidates.find((c) => c.infoHash === "p".repeat(40));
    expect(mkvH264).toBeDefined();
    expect(mkvH264?.container).toBe("mkv");
    expect(mkvH264?.codec).toBe("h264");
  });

  it("keeps representation across native/safari x 1080/2160 classes even when one class dominates the raw list", async () => {
    const streams: { title: string; infoHash: string; fileIdx: number }[] = [];
    // 30 HEVC 4K releases (would fill an old flat top-8/30 cut entirely).
    for (let i = 0; i < 30; i++) {
      streams.push({
        title: `Movie.2024.2160p.UHD.BluRay.x265.HDR.mp4\n👤 ${100 - i} 💾 20 GB ⚙️ X`,
        infoHash: `a${i}`.padEnd(40, "0"),
        fileIdx: 0,
      });
    }
    // A handful of native 1080p and one native 4K release mixed in.
    streams.push({
      title: "Movie.2024.2160p.WEB-DL.H264-GRP.mp4\n👤 10 💾 15 GB ⚙️ X",
      infoHash: "native4k".padEnd(40, "0"),
      fileIdx: 0,
    });
    for (let i = 0; i < 3; i++) {
      streams.push({
        title: `Movie.2024.1080p.WEB-DL.H264-GRP${i}.mp4\n👤 ${5 - i} 💾 2 GB ⚙️ X`,
        infoHash: `n1080${i}`.padEnd(40, "0"),
        fileIdx: 0,
      });
    }

    globalThis.fetch = (async () => jsonResponse({ streams })) as unknown as typeof fetch;

    const candidates = await fetchTorrentioCandidates({
      imdbId: "tt0000002",
      mediaType: "movie",
      rdToken: FAKE_TOKEN,
    });

    const native2160 = candidates.filter((c) => c.compat === "native" && c.resolutionHeight === 2160);
    const safari2160 = candidates.filter((c) => c.compat === "safari" && c.resolutionHeight === 2160);
    const native1080 = candidates.filter((c) => c.compat === "native" && c.resolutionHeight === 1080);

    expect(native2160.length).toBeGreaterThan(0);
    expect(safari2160.length).toBeGreaterThan(0);
    expect(native1080.length).toBe(3);
  });
});
