/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
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
    probe: partial.probe,
  };
}

describe("heightTierForRank", () => {
  it("maps ≥1080 → 2, unknown ≤0 → 1, known sub-HD → 0", () => {
    expect(heightTierForRank(2160)).toBe(2);
    expect(heightTierForRank(HD_FLOOR_HEIGHT)).toBe(2);
    expect(heightTierForRank(0)).toBe(1);
    expect(heightTierForRank(-1)).toBe(1);
    expect(heightTierForRank(720)).toBe(0);
    expect(heightTierForRank(480)).toBe(0);
  });
});

describe("sortSourcesForDefault — R9 height tiers", () => {
  it("1: known 720 loses to unknown maxH=0 (neither ≥1080)", () => {
    const luna720 = src({
      id: "luna",
      maxHeight: 720,
      probe: { ok: true, speedScore: 90 },
    });
    const pulseUnknown = src({ id: "pulse", maxHeight: 0 });
    const ranked = sortSourcesForDefault([luna720, pulseUnknown]);
    expect(ranked[0]?.url).toBe(pulseUnknown.url);
    expect(pickDefaultStreamUrl([luna720, pulseUnknown])).toBe(pulseUnknown.url);
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

  it("probe.ok 720 does not override unknown via pickDefaultStreamUrl", () => {
    // Regression: old pick re-scanned for probe.ok after sort, undoing R9 tiers.
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
    expect(pickDefaultStreamUrl([fast720, unknown])).toBe(unknown.url);
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
});
