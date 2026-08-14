/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  candidateMasterUrls,
  dedupeCapturesByNormalizedUrl,
  looksLikeHlsMasterUrl,
  normalizeStreamUrl,
  qualityRankScore,
  selectEmbedCaptures,
  type SelectableCapture,
} from "./capture-select";
import { inferHeightFromUrl } from "./quality-probe";

function cap(
  url: string,
  overrides: Partial<SelectableCapture> = {}
): SelectableCapture {
  return {
    url,
    quality: "auto",
    label: "HLS",
    referer: "https://embed.example/",
    origin: "https://embed.example",
    userAgent: "test",
    score: 100,
    ...overrides,
  };
}

describe("normalizeStreamUrl", () => {
  it("strips ephemeral auth query keys but keeps path identity", () => {
    const a = normalizeStreamUrl(
      "https://cdn.example/video/1080/index.m3u8?token=abc&expires=99&foo=1"
    );
    const b = normalizeStreamUrl(
      "https://cdn.example/video/1080/index.m3u8?token=zzz&expires=1&foo=1"
    );
    expect(a).toBe(b);
    expect(a).toContain("foo=1");
    expect(a).not.toContain("token=");
    expect(a).not.toContain("expires=");
  });

  it("keeps distinct paths as distinct identities", () => {
    const a = normalizeStreamUrl("https://cdn.example/720/index.m3u8?token=1");
    const b = normalizeStreamUrl("https://cdn.example/1080/index.m3u8?token=1");
    expect(a).not.toBe(b);
  });

  it("keeps ambiguous key selectors that identify distinct quality rungs", () => {
    const hd = normalizeStreamUrl("https://cdn.example/master.m3u8?key=1080&token=a");
    const ultra = normalizeStreamUrl("https://cdn.example/master.m3u8?key=2160&token=b");
    expect(hd).not.toBe(ultra);
    expect(hd).toContain("key=1080");
    expect(ultra).toContain("key=2160");
  });

  it("strips auth-shaped ambiguous keys when explicit auth context is present", () => {
    const first = normalizeStreamUrl(
      "https://cdn.example/master.m3u8?key=0123456789abcdef0123456789abcdef&expires=1"
    );
    const renewed = normalizeStreamUrl(
      "https://cdn.example/master.m3u8?key=fedcba9876543210fedcba9876543210&expires=2"
    );
    expect(first).toBe(renewed);
  });
});

describe("looksLikeHlsMasterUrl", () => {
  it("recognizes master/manifest naming", () => {
    expect(looksLikeHlsMasterUrl("https://cdn.example/master.m3u8")).toBe(true);
    expect(looksLikeHlsMasterUrl("https://cdn.example/hls/manifest.m3u8")).toBe(true);
    expect(looksLikeHlsMasterUrl("https://cdn.example/playlist.m3u8")).toBe(true);
  });

  it("rejects height-folder media playlists even when named index.m3u8", () => {
    expect(looksLikeHlsMasterUrl("https://cdn.example/1080p/index.m3u8")).toBe(false);
    expect(looksLikeHlsMasterUrl("https://cdn.example/720/index.m3u8")).toBe(false);
  });
});

describe("dedupeCapturesByNormalizedUrl", () => {
  it("collapses token rotations onto one capture", () => {
    const out = dedupeCapturesByNormalizedUrl([
      cap("https://cdn.example/master.m3u8?token=a", { score: 90 }),
      cap("https://cdn.example/master.m3u8?token=b", { score: 100, isMaster: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.isMaster).toBe(true);
    expect(out[0]!.score).toBe(100);
  });
});

describe("selectEmbedCaptures", () => {
  it("prefers confirmed master over single-rendition media playlists", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/360/index.m3u8", { score: 100 }),
        cap("https://cdn.example/1080/index.m3u8", { score: 100 }),
        cap("https://cdn.example/master.m3u8", { score: 80, isMaster: true }),
      ],
      3
    );
    expect(out[0]!.url).toContain("master.m3u8");
    expect(out[0]!.isMaster).toBe(true);
  });

  it("prefers master URL heuristic when isMaster flag absent", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/720/chunklist.m3u8"),
        cap("https://cdn.example/hls/master.m3u8", { score: 70 }),
      ],
      2
    );
    expect(out[0]!.url).toContain("master.m3u8");
  });

  it("when only media playlists exist, keeps highest height first", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/360/index.m3u8"),
        cap("https://cdn.example/720/index.m3u8"),
        cap("https://cdn.example/1080/index.m3u8"),
      ],
      3
    );
    expect(inferHeightFromUrl(out[0]!.url)).toBe(1080);
  });

  it("surfaces at most top 2 meaningfully different media heights", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/360/index.m3u8"),
        cap("https://cdn.example/480/index.m3u8"),
        cap("https://cdn.example/720/index.m3u8"),
        cap("https://cdn.example/1080/index.m3u8"),
      ],
      3
    );
    // Highest + one meaningfully lower rung (gap ≥ 200), not all four.
    expect(out.length).toBeLessThanOrEqual(2);
    expect(inferHeightFromUrl(out[0]!.url)).toBe(1080);
    if (out[1]) {
      expect(inferHeightFromUrl(out[1].url)).toBeLessThanOrEqual(720);
    }
  });

  it("does not flood roster beyond maxCount", () => {
    const many = [360, 480, 720, 1080, 1440].map((h) =>
      cap(`https://cdn.example/${h}/index.m3u8`)
    );
    const out = selectEmbedCaptures(many, 2);
    expect(out).toHaveLength(2);
  });

  it("fills remaining slots with DASH/MP4 after HLS", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/master.m3u8", { isMaster: true }),
        cap("https://cdn.example/video.mpd", { label: "DASH", score: 70 }),
        cap("https://cdn.example/file.mp4", { label: "MP4", score: 60 }),
      ],
      3
    );
    expect(out).toHaveLength(3);
    expect(out[0]!.url).toContain(".m3u8");
  });

  it("reconstructs a Vidking-style master from a discrete quality child", () => {
    expect(candidateMasterUrls("https://cdn.example/hls/index-s2160p.m3u8")).toEqual([
      "https://cdn.example/hls/index.m3u8",
      "https://cdn.example/hls/master.m3u8",
      "https://cdn.example/hls/playlist.m3u8",
    ]);
    expect(
      candidateMasterUrls("https://cdn.example/v/2160/index.m3u8?token=a")
    ).toContain("https://cdn.example/v/index.m3u8?token=a");
    expect(candidateMasterUrls("https://cdn.example/master.m3u8")).toEqual([]);
  });

  it("when master exists, does not promote index-s*p child media as separate sources", () => {
    const out = selectEmbedCaptures(
      [
        cap("https://cdn.example/master.m3u8", { isMaster: true, score: 90 }),
        cap("https://cdn.example/index-s2160p.m3u8", { score: 100 }),
        cap("https://cdn.example/index-s480p.m3u8", { score: 100 }),
      ],
      5
    );
    expect(out.some((c) => c.url.includes("index-s"))).toBe(false);
    expect(out[0]!.url).toContain("master.m3u8");
  });
});

describe("qualityRankScore", () => {
  it("ranks higher maxHeight above lower", () => {
    const hi = qualityRankScore({
      url: "https://a/x.m3u8",
      maxHeight: 1080,
      verified: true,
    });
    const lo = qualityRankScore({
      url: "https://b/y.m3u8",
      maxHeight: 720,
      verified: true,
    });
    expect(hi).toBeGreaterThan(lo);
  });

  it("prefers verified over soft-kept even at lower height", () => {
    const soft4k = qualityRankScore({
      url: "https://a/4k.m3u8",
      maxHeight: 2160,
      verified: false,
    });
    const verified1080 = qualityRankScore({
      url: "https://b/1080.m3u8",
      maxHeight: 1080,
      verified: true,
    });
    expect(verified1080).toBeGreaterThan(soft4k);
  });

  it("prefers HLS over MP4 at equal height", () => {
    const hls = qualityRankScore({
      url: "https://a/1080/index.m3u8",
      maxHeight: 1080,
      verified: true,
    });
    const mp4 = qualityRankScore({
      url: "https://a/1080/file.mp4",
      maxHeight: 1080,
      verified: true,
    });
    expect(hls).toBeGreaterThan(mp4);
  });

  it("uses probeOk as secondary boost", () => {
    const ok = qualityRankScore({
      url: "https://a/x.m3u8",
      maxHeight: 1080,
      verified: true,
      probeOk: true,
    });
    const notOk = qualityRankScore({
      url: "https://b/y.m3u8",
      maxHeight: 1080,
      verified: true,
      probeOk: false,
    });
    expect(ok).toBeGreaterThan(notOk);
  });

  it("falls back to URL-token height when maxHeight unset", () => {
    const fromUrl = qualityRankScore({
      url: "https://cdn.example/1080p/index.m3u8",
      verified: true,
    });
    const plain = qualityRankScore({
      url: "https://cdn.example/playlist.m3u8",
      verified: true,
    });
    expect(fromUrl).toBeGreaterThan(plain);
  });
});

describe("inferHeightFromUrl edge cases", () => {
  it("reads path folder and p-suffix tokens", () => {
    expect(inferHeightFromUrl("https://x/1080/index.m3u8")).toBe(1080);
    expect(inferHeightFromUrl("https://x/1080p/index.m3u8")).toBe(1080);
    expect(inferHeightFromUrl("https://x/video_720p.m3u8")).toBe(720);
    expect(inferHeightFromUrl("https://x/4k/master.m3u8")).toBe(2160);
    expect(inferHeightFromUrl("share 2160p")).toBe(2160);
  });

  it("does not invent height from unrelated numbers", () => {
    expect(inferHeightFromUrl("https://cdn.example/playlist/320744abc.m3u8")).toBe(0);
    expect(inferHeightFromUrl("https://cdn.example/seg-0001.ts")).toBe(0);
    expect(inferHeightFromUrl("https://cdn.example/v1/proxy?id=99")).toBe(0);
  });
});
