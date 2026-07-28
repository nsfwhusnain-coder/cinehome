/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  PRIMARY_MAX,
  SECONDARY_MAX,
  VERIFIED_MIN_SKIP_SECONDARY,
  PW_WAIT_MS,
  ENRICH_HARD_TIMEOUT_MS,
  buildPrimarySourceUrls,
  buildSecondarySourceUrls,
  buildSourceUrls,
  countDistinctVidsrcHosts,
  countVerifiedNonPoison,
  embedHostFromUrl,
} from "./embed-roster";

const DEAD_HOST_MARKERS = [
  "smashy",
  "autoembed",
  "moviesapi",
  "embed.su",
] as const;

const DROPPED_FROM_PW = [
  "player.videasy.net",
  "vidlink.pro",
  "vidsrc.cc",
  "vidsrc.rip",
  // 2026-07-21 roster hygiene: 8/8 persistent misses over 24h of prod logs.
  "vidfast.pro",
  "vidsrc.to",
] as const;

function hostsOf(specs: { url: string }[]): string[] {
  return specs.map((s) => embedHostFromUrl(s.url));
}

describe("buildPrimarySourceUrls", () => {
  it("movie primary length ≤ PRIMARY_MAX (5)", () => {
    const primary = buildPrimarySourceUrls(550, "movie");
    expect(primary.length).toBeLessThanOrEqual(PRIMARY_MAX);
    expect(primary.length).toBeLessThanOrEqual(5);
    expect(primary.length).toBeGreaterThan(0);
  });

  it("tv primary length ≤ PRIMARY_MAX (5)", () => {
    const primary = buildPrimarySourceUrls(1396, "tv", 1, 1);
    expect(primary.length).toBeLessThanOrEqual(PRIMARY_MAX);
    expect(primary.length).toBeLessThanOrEqual(5);
  });

  it("includes vidking (Solstice) first", () => {
    const movie = buildPrimarySourceUrls(550, "movie");
    const tv = buildPrimarySourceUrls(1396, "tv", 1, 1);
    expect(hostsOf(movie)[0]).toContain("vidking");
    expect(hostsOf(tv)[0]).toContain("vidking");
    expect(movie.some((s) => s.url.includes("vidking"))).toBe(true);
    expect(tv.some((s) => s.url.includes("vidking"))).toBe(true);
  });

  it("marks all primary specs as priority=primary", () => {
    for (const s of buildPrimarySourceUrls(550, "movie")) {
      expect(s.priority).toBe("primary");
    }
  });

  it("has no vidsrc mirror in primary (vidsrc.to dropped — persistent dead host)", () => {
    const primary = buildPrimarySourceUrls(550, "movie");
    const vidsrc = hostsOf(primary).filter((h) => h.includes("vidsrc"));
    expect(vidsrc.length).toBe(0);
  });

  it("has no vidfast (dropped — persistent dead host) in primary", () => {
    const primary = buildPrimarySourceUrls(550, "movie");
    expect(primary.some((s) => s.url.includes("vidfast"))).toBe(false);
  });

  it("primary is exactly the measured productive Vidking host", () => {
    const movie = buildPrimarySourceUrls(550, "movie");
    expect(hostsOf(movie)).toEqual(["www.vidking.net"]);
    expect(movie.some((s) => s.url.includes("vidnest"))).toBe(false);
  });
});

describe("buildSecondarySourceUrls", () => {
  it("secondary length ≤ SECONDARY_MAX", () => {
    expect(buildSecondarySourceUrls(550, "movie").length).toBeLessThanOrEqual(
      SECONDARY_MAX
    );
    expect(
      buildSecondarySourceUrls(1396, "tv", 2, 3).length
    ).toBeLessThanOrEqual(SECONDARY_MAX);
  });

  it("includes 2embed and multiembed", () => {
    const movie = buildSecondarySourceUrls(550, "movie");
    const hosts = hostsOf(movie).join(" ");
    expect(hosts).toContain("2embed");
    expect(hosts).toContain("multiembed");
  });

  it("marks all secondary specs as priority=secondary", () => {
    for (const s of buildSecondarySourceUrls(550, "movie")) {
      expect(s.priority).toBe("secondary");
    }
  });

  it("extra vidsrc is .me (not primary's .to)", () => {
    const secondary = buildSecondarySourceUrls(550, "movie");
    const vidsrc = hostsOf(secondary).filter((h) => h.includes("vidsrc"));
    expect(vidsrc.length).toBe(1);
    expect(vidsrc[0]).toContain("vidsrc.me");
  });
});

describe("buildSourceUrls full roster policy", () => {
  it("has no smashy / autoembed / moviesapi / embed.su", () => {
    const full = [
      ...buildSourceUrls(550, "movie"),
      ...buildSourceUrls(1396, "tv", 1, 1),
    ];
    const blob = full.map((s) => s.url.toLowerCase()).join("\n");
    for (const dead of DEAD_HOST_MARKERS) {
      expect(blob.includes(dead)).toBe(false);
    }
  });

  it("drops videasy embed, vidlink embed, vidsrc.cc, vidsrc.rip from PW roster", () => {
    const full = buildSourceUrls(550, "movie");
    const blob = full.map((s) => s.url.toLowerCase()).join("\n");
    for (const dropped of DROPPED_FROM_PW) {
      expect(blob.includes(dropped)).toBe(false);
    }
  });

  it("at most 2 distinct vidsrc* hosts across primary+secondary", () => {
    const movie = buildSourceUrls(550, "movie");
    const tv = buildSourceUrls(1396, "tv", 5, 2);
    expect(countDistinctVidsrcHosts(movie)).toBeLessThanOrEqual(2);
    expect(countDistinctVidsrcHosts(tv)).toBeLessThanOrEqual(2);
    // Only vidsrc.me remains (secondary) — .to dropped from primary as dead.
    expect(countDistinctVidsrcHosts(movie)).toBe(1);
  });

  it("full roster length is primary+secondary caps", () => {
    const movie = buildSourceUrls(550, "movie");
    expect(movie.length).toBeLessThanOrEqual(PRIMARY_MAX + SECONDARY_MAX);
    expect(movie.length).toBe(
      buildPrimarySourceUrls(550, "movie").length +
        buildSecondarySourceUrls(550, "movie").length
    );
  });

  it("tv season 0 is not truthiness-dropped (uses != null path)", () => {
    // season 0 must still produce TV URLs when season/episode provided.
    const specs = buildPrimarySourceUrls(1396, "tv", 0, 1);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.url.includes("/tv/") || s.url.includes("embed/tv"))).toBe(
      true
    );
  });
});

describe("countVerifiedNonPoison / secondary gate", () => {
  const isPoison = (url: string) => url.includes("poison");

  it("counts only verified non-poison", () => {
    const n = countVerifiedNonPoison(
      [
        { url: "https://a/m.m3u8", verified: true },
        { url: "https://b/m.m3u8", verified: false },
        { url: "https://poison.example/x.m3u8", verified: true },
        { url: "https://c/m.m3u8" }, // unflagged = verified
      ],
      isPoison
    );
    expect(n).toBe(2);
  });

  it("secondary skip threshold is 2", () => {
    expect(VERIFIED_MIN_SKIP_SECONDARY).toBe(2);
    expect(
      countVerifiedNonPoison(
        [{ url: "https://a" }, { url: "https://b" }],
        () => false
      )
    ).toBeGreaterThanOrEqual(VERIFIED_MIN_SKIP_SECONDARY);
  });
});

describe("Phase 3 intercept budget constants", () => {
  it("PW wall is ~18–22s (not the old 28s/55s)", () => {
    expect(PW_WAIT_MS).toBeGreaterThanOrEqual(18_000);
    expect(PW_WAIT_MS).toBeLessThanOrEqual(22_000);
  });

  it("enrich hard timeout is ~25–30s (not the old 38s/60s)", () => {
    expect(ENRICH_HARD_TIMEOUT_MS).toBeGreaterThanOrEqual(25_000);
    expect(ENRICH_HARD_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(ENRICH_HARD_TIMEOUT_MS).toBeGreaterThan(PW_WAIT_MS);
  });

  it("primary capture keeps early-exit headroom without consuming the secondary wall", () => {
    const primary = buildPrimarySourceUrls(550, "movie");
    for (const s of primary) {
      expect(s.captureWaitMs).toBe(8_000);
      expect(s.workerBudgetMs).toBe(12_000);
      expect(s.gotoTimeoutMs).toBe(11_000);
      expect(PW_WAIT_MS - s.workerBudgetMs).toBeGreaterThanOrEqual(8_000);
    }
  });

  it("secondary budgets are tighter than primary", () => {
    const secondary = buildSecondarySourceUrls(550, "movie");
    for (const s of secondary) {
      expect(s.captureWaitMs).toBe(5_000);
      expect(s.workerBudgetMs).toBe(10_000);
      expect(s.gotoTimeoutMs).toBe(8_000);
      expect(s.captureWaitMs).toBeLessThan(8_000);
    }
  });
});
