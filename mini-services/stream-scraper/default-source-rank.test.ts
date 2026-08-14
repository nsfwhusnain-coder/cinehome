/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  animeProviderBoost,
  HD_FLOOR_HEIGHT,
  heightTierForRank,
  pickDefaultStreamUrl,
  sortSourcesForDefault,
  type RankableSource,
} from "./default-source-rank";

function src(
  partial: Partial<RankableSource> & { id: string; maxHeight?: number }
): RankableSource & { id: string } {
  const id = partial.id;
  return {
    id,
    url: partial.url ?? `https://cdn.example/${id}.m3u8`,
    label: partial.label ?? id,
    quality: partial.quality ?? "auto",
    provider: partial.provider ?? id,
    verified: partial.verified,
    maxHeight: partial.maxHeight,
    ladder: partial.ladder,
    bitrateBps: partial.bitrateBps,
    probe: partial.probe,
  };
}

describe("heightTierForRank", () => {
  it("maps ≥1080 → 3, ≥720 → 2, unknown ≤0 → 1, known sub-720 → 0", () => {
    expect(heightTierForRank(2160)).toBe(3);
    expect(heightTierForRank(HD_FLOOR_HEIGHT)).toBe(3);
    expect(heightTierForRank(720)).toBe(2);
    expect(heightTierForRank(0)).toBe(1);
    expect(heightTierForRank(-1)).toBe(1);
    expect(heightTierForRank(480)).toBe(0);
  });
});

describe("sortSourcesForDefault — R9 height tiers", () => {
  it("1: known 720 beats unknown maxH=0 (do not autoplay mystery 480p)", () => {
    const luna720 = src({
      id: "luna",
      maxHeight: 720,
      probe: { ok: true, speedScore: 90 },
    });
    const pulseUnknown = src({ id: "pulse", maxHeight: 0 });
    const ranked = sortSourcesForDefault([luna720, pulseUnknown]);
    expect(ranked[0]?.url).toBe(luna720.url);
    expect(pickDefaultStreamUrl([luna720, pulseUnknown])).toBe(luna720.url);
  });

  it("2: known 1080 beats unknown maxH=0", () => {
    const hd = src({ id: "solstice", maxHeight: 1080 });
    const unknown = src({ id: "pulse", maxHeight: 0 });
    const ranked = sortSourcesForDefault([unknown, hd]);
    expect(ranked[0]?.url).toBe(hd.url);
  });

  it("3: 2160 beats 1080 within HD tier", () => {
    const s1080 = src({ id: "s1080", maxHeight: 1080 });
    const s2160 = src({ id: "s2160", maxHeight: 2160 });
    const ranked = sortSourcesForDefault([s1080, s2160]);
    expect(ranked[0]?.url).toBe(s2160.url);
  });

  it("3b: qualityHint 2160 prefers 4K among tier-2 sources", () => {
    const s1080 = src({ id: "s1080", maxHeight: 1080 });
    const s2160 = src({ id: "s2160", maxHeight: 2160 });
    const ranked = sortSourcesForDefault([s1080, s2160], {
      qualityHintHeight: 2160,
    });
    expect(ranked[0]?.url).toBe(s2160.url);
  });

  it("4: among known sub-HD, 720 beats 480", () => {
    const s480 = src({ id: "s480", maxHeight: 480 });
    const s720 = src({ id: "s720", maxHeight: 720 });
    const ranked = sortSourcesForDefault([s480, s720]);
    expect(ranked[0]?.url).toBe(s720.url);
  });

  it("5: soft-kept never beats verified at equal/unknown tiers", () => {
    const softUnknown = src({
      id: "soft",
      maxHeight: 0,
      verified: false,
    });
    const verifiedUnknown = src({
      id: "ok",
      maxHeight: 0,
      verified: true,
    });
    const ranked = sortSourcesForDefault([softUnknown, verifiedUnknown]);
    expect(ranked[0]?.url).toBe(verifiedUnknown.url);

    // Soft 1080 still loses to verified unknown (verified gate first).
    const softHd = src({
      id: "soft-hd",
      maxHeight: 1080,
      verified: false,
    });
    const verifiedSub = src({
      id: "ok-sub",
      maxHeight: 720,
      verified: true,
    });
    const ranked2 = sortSourcesForDefault([softHd, verifiedSub]);
    expect(ranked2[0]?.url).toBe(verifiedSub.url);
  });

  it("probe.ok 720 still wins over unknown via pickDefaultStreamUrl", () => {
    const fast720 = src({
      id: "luna",
      maxHeight: 720,
      probe: { ok: true, speedScore: 95 },
      verified: true,
    });
    const unknown = src({
      id: "pulse",
      maxHeight: 0,
      verified: true,
    });
    expect(pickDefaultStreamUrl([fast720, unknown])).toBe(fast720.url);
  });

  it("multi-rung ladder beats single-rung at equal height", () => {
    const single = src({ id: "single", maxHeight: 1080, ladder: [1080] });
    const multi = src({
      id: "multi",
      maxHeight: 1080,
      ladder: [1080, 720, 480],
    });
    const ranked = sortSourcesForDefault([single, multi]);
    expect(ranked[0]?.url).toBe(multi.url);
  });
});

describe("sortSourcesForDefault — equal-resolution bitrate", () => {
  it("keeps 4K ahead of a higher-bitrate 1080p source", () => {
    const hd = src({ id: "hd", maxHeight: 1080, bitrateBps: 20_000_000 });
    const uhd = src({ id: "uhd", maxHeight: 2160, bitrateBps: 12_000_000 });

    expect(sortSourcesForDefault([hd, uhd])[0]?.url).toBe(uhd.url);
  });

  it("prefers rich fixed 1080p over lean adaptive 1080p", () => {
    const lean = src({
      id: "lean-adaptive",
      maxHeight: 1080,
      ladder: [1080, 720, 480],
      bitrateBps: 2_500_000,
    });
    const rich = src({
      id: "rich-fixed",
      maxHeight: 1080,
      ladder: [1080],
      bitrateBps: 10_000_000,
    });

    expect(sortSourcesForDefault([lean, rich])[0]?.url).toBe(rich.url);
  });

  it("keeps probe failure ahead of no quality preference", () => {
    const healthy = src({
      id: "healthy",
      maxHeight: 1080,
      bitrateBps: 3_000_000,
      probe: { ok: true, speedScore: 60 },
    });
    const deadRich = src({
      id: "dead-rich",
      maxHeight: 1080,
      bitrateBps: 18_000_000,
      probe: { ok: false, speedScore: 0 },
    });

    expect(sortSourcesForDefault([deadRich, healthy])[0]?.url).toBe(healthy.url);
  });

  it("keeps an unprobed fallback above a known-dead rich source", () => {
    const fallback = src({
      id: "fallback",
      maxHeight: 1080,
      bitrateBps: 3_000_000,
    });
    const deadRich = src({
      id: "dead-rich",
      maxHeight: 1080,
      bitrateBps: 12_000_000,
      probe: { ok: false, speedScore: 0, bytesPerSec: 0 },
    });
    expect(sortSourcesForDefault([deadRich, fallback])[0]?.url).toBe(
      fallback.url
    );
  });

  it("rejects a fixed rich encode that measured throughput cannot sustain", () => {
    const lean = src({
      id: "lean",
      maxHeight: 1080,
      bitrateBps: 3_000_000,
      probe: { ok: true, speedScore: 60, bytesPerSec: 1_000_000 },
    });
    const starving = src({
      id: "starving",
      maxHeight: 1080,
      bitrateBps: 10_000_000,
      probe: { ok: true, speedScore: 85, bytesPerSec: 500_000 },
    });
    expect(sortSourcesForDefault([starving, lean])[0]?.url).toBe(lean.url);
  });

  it("is permutation-stable with measured and unknown rates", () => {
    const lean = src({
      id: "lean",
      maxHeight: 1080,
      bitrateBps: 4_000_000,
      ladder: [1080, 720],
    });
    const unknown = src({
      id: "unknown",
      maxHeight: 1080,
      ladder: [1080, 720],
    });
    const rich = src({ id: "rich", maxHeight: 1080, bitrateBps: 6_000_000 });
    const permutations = [
      [lean, unknown, rich],
      [lean, rich, unknown],
      [unknown, lean, rich],
      [unknown, rich, lean],
      [rich, lean, unknown],
      [rich, unknown, lean],
    ];

    for (const roster of permutations) {
      expect(sortSourcesForDefault(roster).map((entry) => entry.id)).toEqual([
        "rich",
        "lean",
        "unknown",
      ]);
    }
  });
});

describe("sortSourcesForDefault — anime ranking boost", () => {
  it("prefers Vidrock and NoTorrent over Luna at equal height when contentClass=anime", () => {
    const luna = src({
      id: "luna",
      provider: "Vixsrc",
      label: "Luna",
      maxHeight: 1080,
    });
    const rock = src({
      id: "rock",
      provider: "Vidrock",
      label: "Rock",
      maxHeight: 1080,
    });
    const pulse = src({
      id: "pulse",
      provider: "NoTorrent",
      label: "Pulse",
      maxHeight: 1080,
    });
    expect(animeProviderBoost("Vidrock", "Rock", "anime")).toBeGreaterThan(0);
    expect(animeProviderBoost("NoTorrent", "Pulse", "anime")).toBeGreaterThan(0);
    expect(animeProviderBoost("Vixsrc", "Luna", "anime")).toBe(0);

    const ranked = sortSourcesForDefault([luna, rock, pulse], {
      contentClass: "anime",
    });
    expect(ranked.map((entry) => entry.id)).toEqual(["rock", "pulse", "luna"]);

    const defaultRanked = sortSourcesForDefault([luna, rock, pulse]);
    expect(defaultRanked[0]?.id).toBe("luna");
  });

  it("does not let a 720 Rock beat 1080 Luna even on anime", () => {
    const luna = src({
      id: "luna",
      provider: "Vixsrc",
      label: "Luna",
      maxHeight: 1080,
    });
    const rock = src({
      id: "rock",
      provider: "Vidrock",
      label: "Rock",
      maxHeight: 720,
    });
    expect(
      sortSourcesForDefault([rock, luna], { contentClass: "anime" })[0]?.id
    ).toBe("luna");
  });
});

describe("sortSourcesForDefault — English over foreign CinemaOS", () => {
  it("does not pick Hindi 1080 over Luna or unlabeled Cinema", () => {
    const hindi = src({
      id: "cinema-hi",
      label: "Cinema HI 1080",
      provider: "CinemaOS",
      maxHeight: 1080,
    });
    const luna = src({
      id: "luna",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 1080,
    });
    const cinema = src({
      id: "cinema",
      label: "Cinema",
      provider: "CinemaOS",
      maxHeight: 1080,
    });
    expect(pickDefaultStreamUrl([hindi, luna])).toBe(luna.url);
    expect(pickDefaultStreamUrl([hindi, cinema])).toBe(cinema.url);
    expect(sortSourcesForDefault([hindi, luna, cinema])[0]?.id).not.toBe(
      "cinema-hi"
    );
  });
});

describe("sortSourcesForDefault — poison gate", () => {
  it("poison probe.ok 1080 loses to clean 720 HLS", () => {
    const abuse = src({
      id: "abuse",
      url: "https://cloudflare-terms-of-service-abuse.com/stream.mp4",
      maxHeight: 1080,
      probe: { ok: true, speedScore: 100 },
      verified: true,
    });
    const luna = src({
      id: "luna",
      url: "https://moon.ironwallnet.net/hls/movie/abc/index.m3u8",
      maxHeight: 720,
      probe: { ok: true, speedScore: 40 },
      verified: true,
    });
    const ranked = sortSourcesForDefault([abuse, luna]);
    expect(ranked[0]?.url).toBe(luna.url);
    expect(pickDefaultStreamUrl([abuse, luna])).toBe(luna.url);
  });

  it("hostinger php loses to luna m3u8", () => {
    const hostinger = src({
      id: "pulse-php",
      url: "https://foo.hostingersite.com/vid1.php?id=99",
      maxHeight: 1080,
      probe: { ok: true, speedScore: 95 },
      verified: true,
      provider: "notorrent",
      label: "Pulse",
    });
    const luna = src({
      id: "luna",
      url: "https://moon.ironwallnet.net/hls/s1e1/master.m3u8",
      maxHeight: 720,
      verified: true,
      provider: "vixsrc",
      label: "Luna",
    });
    expect(pickDefaultStreamUrl([hostinger, luna])).toBe(luna.url);
  });

  it("hostinger php loses to solstice m3u8", () => {
    const php = src({
      id: "php",
      url: "https://bar.hostingersite.com/stream.php?x=1",
      maxHeight: 0,
      verified: true,
    });
    const solstice = src({
      id: "solstice",
      url: "https://moon.ironbubble.site/playlist/master.m3u8",
      maxHeight: 1080,
      verified: true,
      provider: "vidking",
      label: "Solstice",
    });
    expect(pickDefaultStreamUrl([php, solstice])).toBe(solstice.url);
  });

  it("only poison → still returns a url (last resort)", () => {
    const a = src({
      id: "a",
      url: "https://cloudflare-terms-of-service-abuse.com/a.mp4",
      maxHeight: 1080,
    });
    const b = src({
      id: "b",
      url: "https://x.hostingersite.com/vid1.php?id=1",
      maxHeight: 720,
    });
    const pick = pickDefaultStreamUrl([a, b]);
    expect(pick).toBeTruthy();
    expect(
      pick === a.url || pick === b.url
    ).toBe(true);
  });

  it("poison soft-kept never beats clean soft-kept", () => {
    const poison = src({
      id: "poison",
      url: "https://cloudflare-terms-of-service-abuse.com/x.mp4",
      maxHeight: 1080,
      verified: false,
    });
    const clean = src({
      id: "clean",
      url: "https://sacdn.hakunaymatata.com/videos/abc.mp4",
      maxHeight: 480,
      verified: false,
    });
    expect(pickDefaultStreamUrl([poison, clean])).toBe(clean.url);
  });

  it("trailer / sample embed never auto-defaults over a clean source", () => {
    const trailer = src({
      id: "trailer",
      url: "https://cdn.example.com/hls/trailer/master.m3u8",
      maxHeight: 1080,
      probe: { ok: true, speedScore: 99 },
      verified: true,
    });
    const sample = src({
      id: "sample",
      url: "https://cdn.example.com/videos/sample.mp4",
      maxHeight: 1080,
      probe: { ok: true, speedScore: 90 },
      verified: true,
    });
    const labeled = src({
      id: "labeled",
      url: "https://moon.ironwallnet.net/hls/clip/index.m3u8",
      label: "Official Trailer",
      maxHeight: 1080,
      probe: { ok: true, speedScore: 95 },
      verified: true,
    });
    const luna = src({
      id: "luna",
      url: "https://moon.ironwallnet.net/hls/movie/abc/index.m3u8",
      label: "Luna",
      maxHeight: 720,
      probe: { ok: true, speedScore: 40 },
      verified: true,
    });
    expect(pickDefaultStreamUrl([trailer, luna])).toBe(luna.url);
    expect(pickDefaultStreamUrl([sample, luna])).toBe(luna.url);
    expect(pickDefaultStreamUrl([labeled, luna])).toBe(luna.url);
    expect(pickDefaultStreamUrl([trailer, sample])).toBeTruthy();
  });
});
