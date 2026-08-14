/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  decodedQualityHeight,
  findNewSourceIds,
  findQualityUpgradeSource,
  isFasterSource,
  isRuntimeSourceUnhealthy,
  isSourcePlayableHere,
  sourceDelivery,
  parseMaxHeight,
  pickDefaultSource,
  qualityBadge,
  resolvePreferredHeightTarget,
  sortSourcesForPicker,
  sourceMaxHeight,
  sourceRosterMaxHeight,
  sourceRosterMeetsHdFloor,
  sourceHealthState,
  withDetectedSourceHeight,
} from "./source-quality";
import type { PlaybackSource } from "./types";

/**
 * Regression coverage for the owner's "1080p is the absolute base" rule:
 * the auto-default must never land on a sub-1080 source when an HD one
 * exists anywhere in the roster, and a roster with no HD source at all must
 * be honestly flagged (task 6) rather than happily defaulting to whatever
 * is available.
 */
function makeSource(overrides: Partial<PlaybackSource>): PlaybackSource {
  return {
    id: overrides.id ?? "src-1",
    url: overrides.url ?? "https://example.com/stream.m3u8",
    provider: overrides.provider ?? "TestProvider",
    quality: overrides.quality ?? "auto",
    label: overrides.label ?? "Server",
    type: overrides.type ?? "hls",
    ...overrides,
  };
}

describe("decodedQualityHeight", () => {
  it("treats cropped 1920-wide cinema rasters as the 1080p tier", () => {
    expect(decodedQualityHeight(1920, 960)).toBe(1080);
    expect(decodedQualityHeight(1920, 816)).toBe(1080);
    expect(decodedQualityHeight(1920, 800)).toBe(1080);
  });

  it("keeps genuinely low-width playback below the HD floor", () => {
    expect(decodedQualityHeight(1282, 534)).toBe(720);
    expect(decodedQualityHeight(720, 360)).toBe(360);
  });

  it("handles portrait and unknown-width media without inventing 4K", () => {
    expect(decodedQualityHeight(1080, 1920)).toBe(1080);
    expect(decodedQualityHeight(0, 960)).toBe(960);
  });
});

describe("sourceRosterMeetsHdFloor / sourceRosterMaxHeight", () => {
  it("true when a 1080p source exists alongside a 720p one", () => {
    const sources = [
      makeSource({ id: "a", label: "Luna", maxHeight: 720 }),
      makeSource({ id: "b", label: "Aether", maxHeight: 1080 }),
    ];
    expect(sourceRosterMeetsHdFloor(sources)).toBe(true);
    expect(sourceRosterMaxHeight(sources)).toBe(1080);
  });

  it("false when every source in the roster is confirmed sub-1080 (task 6)", () => {
    const sources = [
      makeSource({ id: "a", label: "Luna", maxHeight: 720 }),
      makeSource({ id: "b", label: "Nova", maxHeight: 480 }),
    ];
    expect(sourceRosterMeetsHdFloor(sources)).toBe(false);
    expect(sourceRosterMaxHeight(sources)).toBe(720);
  });

  it("empty roster never claims the HD floor is met", () => {
    expect(sourceRosterMeetsHdFloor([])).toBe(false);
    expect(sourceRosterMaxHeight([])).toBe(0);
  });
});

describe("pickDefaultSource — HD-floor-first ranking", () => {
  it("uses a stable source-id tie-break independent of resolver arrival order", () => {
    const alpha = makeSource({
      id: "cinema-alpha",
      provider: "CinemaOS",
      label: "Cinema XX 1080",
      type: "mp4",
      maxHeight: 1080,
    });
    const beta = makeSource({
      id: "cinema-beta",
      provider: "CinemaOS",
      label: "Cinema XX 1080",
      type: "mp4",
      maxHeight: 1080,
    });
    expect(pickDefaultSource([beta, alpha])?.id).toBe(alpha.id);
    expect(pickDefaultSource([alpha, beta])?.id).toBe(alpha.id);
    expect(sortSourcesForPicker([beta, alpha]).map((source) => source.id)).toEqual([
      alpha.id,
      beta.id,
    ]);
  });

  it("picks the 1080p source over a 720p one", () => {
    const sourceLuna = makeSource({ id: "luna", label: "Luna", provider: "Vixsrc", maxHeight: 720 });
    const sourceAether = makeSource({ id: "aether", label: "Aether", provider: "CinePro", maxHeight: 1080 });
    const picked = pickDefaultSource([sourceLuna, sourceAether]);
    expect(picked?.id).toBe("aether");
  });

  it("never lets a confirmed-working 720p source outrank an untested 1080p source", () => {
    // Regression for the pre-fix tier order: probe.ok / isTopTierSource ran
    // BEFORE the height comparison, so a probe-verified 720p HLS source could
    // beat an unprobed (but confirmed 1080p) source. The HD floor tier must
    // now run first, unconditionally.
    const fastLuna = makeSource({
      id: "luna",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 720,
      probe: { ok: true, ttfbMs: 40, bytesPerSec: 5_000_000, speedScore: 90 },
      verified: true,
    });
    const untested1080 = makeSource({
      id: "aether",
      label: "Aether",
      provider: "CinePro",
      maxHeight: 1080,
    });
    const picked = pickDefaultSource([fastLuna, untested1080]);
    expect(picked?.id).toBe("aether");
  });

  it("a 1080p source wins even when it isn't 'top tier' format (progressive mp4) and the 720p one is HLS", () => {
    const hls720 = makeSource({
      id: "hls720",
      label: "Phoenix",
      provider: "VidLink",
      type: "hls",
      maxHeight: 720,
    });
    const mp41080 = makeSource({
      id: "mp41080",
      label: "Share",
      provider: "Fshare",
      type: "mp4",
      maxHeight: 1080,
    });
    const picked = pickDefaultSource([hls720, mp41080]);
    expect(picked?.id).toBe("mp41080");
  });

  it("given ONLY sub-1080 sources, still returns the best available (for opt-in play) while sourceRosterMeetsHdFloor flags no-1080", () => {
    const sources = [
      makeSource({ id: "a", label: "Luna", provider: "Vixsrc", maxHeight: 720 }),
      makeSource({ id: "b", label: "Nova", provider: "embed.su", maxHeight: 480 }),
    ];
    // pickDefaultSource keeps returning a concrete pick — task 6's gate lives
    // at the caller (video-player.tsx), driven by sourceRosterMeetsHdFloor,
    // not by pickDefaultSource silently returning null.
    const picked = pickDefaultSource(sources);
    expect(picked?.id).toBe("a");
    expect(sourceRosterMeetsHdFloor(sources)).toBe(false);
  });

  it("4K outranks 1080p when both meet the floor (real resolution tie-break)", () => {
    const s1080 = makeSource({ id: "s1080", label: "Aether", maxHeight: 1080 });
    const s2160 = makeSource({ id: "s2160", label: "Horizon", maxHeight: 2160 });
    const picked = pickDefaultSource([s1080, s2160]);
    expect(picked?.id).toBe("s2160");
  });

  it("does not let a saved 1080p server override an available Ultra target", () => {
    const saved1080 = makeSource({
      id: "eos-1080",
      provider: "Vixsrc",
      label: "Eos",
      maxHeight: 1080,
    });
    const available4k = makeSource({
      id: "zeus-4k",
      provider: "Vidking",
      label: "Zeus",
      maxHeight: 2160,
    });

    expect(pickDefaultSource([saved1080, available4k], "Vixsrc|Eos", 2160)?.id).toBe(
      "zeus-4k"
    );
  });

  it("keeps the saved server when the requested quality is unavailable", () => {
    const saved1080 = makeSource({
      id: "eos-1080",
      provider: "Vixsrc",
      label: "Eos",
      maxHeight: 1080,
    });
    const fallback1080 = makeSource({
      id: "other-1080",
      provider: "Other",
      label: "Fallback",
      maxHeight: 1080,
    });

    expect(pickDefaultSource([fallback1080, saved1080], "Vixsrc|Eos", 2160)?.id).toBe(
      "eos-1080"
    );
  });

  it("a Safari-only HEVC debrid source never auto-defaults over a native-playable 1080p source (no window/HEVC support in this env)", () => {
    const debridHevc = makeSource({
      id: "debrid-hevc",
      label: "Real-Debrid",
      provider: "Torrentio",
      maxHeight: 2160,
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
    });
    const nativeHd = makeSource({
      id: "native-hd",
      label: "Aether",
      provider: "CinePro",
      maxHeight: 1080,
    });
    const picked = pickDefaultSource([debridHevc, nativeHd]);
    expect(picked?.id).toBe("native-hd");
  });

  it("empty roster returns null", () => {
    expect(pickDefaultSource([])).toBeNull();
  });

  it("ladder[0] counts as HD for floor ranking even without maxHeight", () => {
    const sub = makeSource({
      id: "sub",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 720,
      probe: { ok: true, ttfbMs: 40, bytesPerSec: 5_000_000, speedScore: 90 },
    });
    const hdLadder = makeSource({
      id: "hd-ladder",
      label: "Aether",
      provider: "CinePro",
      ladder: [1080, 720, 480],
    });
    const picked = pickDefaultSource([sub, hdLadder]);
    expect(picked?.id).toBe("hd-ladder");
    expect(sourceRosterMeetsHdFloor([sub, hdLadder])).toBe(true);
  });

  it("unknown-height sources stay in pool and can be picked when no known HD exists", () => {
    // Regression: HD preference must rank, not filter — unknown maxHeight
    // used to be treated as sub-HD / dropped from auto-play.
    const unknown = makeSource({
      id: "unknown",
      label: "Phoenix",
      provider: "VidLink",
      maxHeight: 0,
      verified: true,
    });
    const slow720 = makeSource({
      id: "slow720",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 720,
      probe: { ok: true, ttfbMs: 40, bytesPerSec: 5_000_000, speedScore: 90 },
    });
    const picked = pickDefaultSource([slow720, unknown]);
    // Unknown tiers above known sub-HD so playback can start.
    expect(picked?.id).toBe("unknown");
  });

  it("probe-ok 720 pool still admits untested 1080 so HD floor ranking can win", () => {
    // Mirrors autoPlayPool: when probeOk has no HD, untested HD sources are
    // merged into the pool — otherwise pickDefaultSource never sees them.
    const fast720 = makeSource({
      id: "fast720",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 720,
      probe: { ok: true, ttfbMs: 30, bytesPerSec: 8_000_000, speedScore: 95 },
      verified: true,
    });
    const untestedHd = makeSource({
      id: "untested-hd",
      label: "Solstice",
      provider: "Vidking",
      maxHeight: 1080,
    });
    const picked = pickDefaultSource([fast720, untestedHd]);
    expect(picked?.id).toBe("untested-hd");
  });

  it("native 1080p debrid outranks equal-height Luna HLS", () => {
    const luna = makeSource({
      id: "luna",
      provider: "Vixsrc",
      label: "Luna",
      type: "hls",
      maxHeight: 1080,
      url: "/api/hls/luna?u=clean",
    });
    const debrid = makeSource({
      id: "debrid-native",
      provider: "Debrid",
      label: "1080p • Debrid",
      origin: "debrid",
      type: "mp4",
      maxHeight: 1080,
      codec: "h264",
      container: "mp4",
      compat: "native",
      url: "https://download.real-debrid.example/movie.mp4",
    });

    expect(pickDefaultSource([luna, debrid])?.id).toBe("debrid-native");
    expect(isFasterSource(luna, debrid)).toBe(true);
  });
});

describe("pickDefaultSource — learned provider health", () => {
  const unreliable = makeSource({
    id: "unreliable",
    provider: "Vidking",
    label: "Solstice",
    maxHeight: 1080,
    runtimeHealth: { successRate: 0.2, sampleCount: 10 },
  });
  const fallback = makeSource({
    id: "fallback",
    provider: "Fallback",
    label: "Fallback",
    maxHeight: 1080,
  });

  it("skips a mature unhealthy provider while an alternative exists", () => {
    expect(isRuntimeSourceUnhealthy(unreliable)).toBe(true);
    expect(pickDefaultSource([unreliable, fallback])?.id).toBe("fallback");
    expect(sortSourcesForPicker([unreliable, fallback])[0]?.id).toBe("fallback");
    expect(sourceHealthState(unreliable)).toBe("weak");
  });

  it("keeps an unhealthy provider as a last resort", () => {
    expect(pickDefaultSource([unreliable])?.id).toBe("unreliable");
  });

  it("honors an open cooldown before the rolling sample threshold", () => {
    const coolingDown = makeSource({
      ...unreliable,
      id: "cooling-down",
      runtimeHealth: {
        successRate: 0,
        sampleCount: 3,
        cooldownUntil: Date.now() + 60_000,
      },
    });
    expect(pickDefaultSource([coolingDown, fallback])?.id).toBe("fallback");
  });

  it("never promotes soft or probe-dead rows above a cooling viable source", () => {
    const coolingViable = makeSource({
      id: "cooling-viable",
      provider: "Viable",
      verified: true,
      probe: { ok: true, ttfbMs: 100, bytesPerSec: 1_000_000, speedScore: 70 },
      runtimeHealth: {
        successRate: 0,
        sampleCount: 3,
        cooldownUntil: Date.now() + 60_000,
      },
    });
    const soft = makeSource({ id: "soft", provider: "Soft", verified: false });
    const dead = makeSource({
      id: "dead",
      provider: "Dead",
      probe: { ok: false, ttfbMs: 5_000, bytesPerSec: 0, speedScore: 0 },
    });

    expect(pickDefaultSource([coolingViable, soft])?.id).toBe("cooling-viable");
    expect(pickDefaultSource([coolingViable, dead])?.id).toBe("cooling-viable");
    expect(sortSourcesForPicker([coolingViable, dead])[0]?.id).toBe(
      "cooling-viable"
    );
  });
});

/**
 * Delivery routing (`sourceDelivery`). An MKV is a container problem, not a
 * dead end: the server rewraps it with a stream copy, preserving resolution
 * and codec. A codec this browser cannot decode is a genuine dead end.
 */
describe("pickDefaultSource / sortSourcesForPicker — delivery routing", () => {
  const mkv4k = makeSource({
    id: "mkv-4k",
    provider: "Debrid",
    origin: "debrid",
    compat: "native",
    codec: "h264",
    container: "mkv",
    maxHeight: 2160,
  });
  const native1080 = makeSource({ id: "native-1080", label: "Aether", maxHeight: 1080 });

  it("auto-defaults to a remuxable 4K source over a direct 1080p one — the remux keeps the 4K", () => {
    // The stream copy does not re-encode, so this really is 2160p on screen.
    // Capping it behind 1080p was the bug: the roster carried 4K all along.
    expect(pickDefaultSource([mkv4k, native1080])?.id).toBe("mkv-4k");
  });

  it("prefers the direct source at EQUAL height — a rewrap that buys no resolution is pure cost", () => {
    const mkv1080 = makeSource({
      id: "mkv-1080",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mkv",
      maxHeight: 1080,
    });
    const mp41080 = makeSource({
      id: "mp4-1080",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mp4",
      maxHeight: 1080,
    });
    expect(pickDefaultSource([mkv1080, mp41080])?.id).toBe("mp4-1080");
    expect(sortSourcesForPicker([mkv1080, mp41080]).map((s) => s.id)).toEqual([
      "mp4-1080",
      "mkv-1080",
    ]);
  });

  it("lets a validated debrid remux beat an equal-height embed that has no health evidence", () => {
    // Not a contradiction of the rule above — delivery cost is only ONE signal
    // and it deliberately sits below health evidence in the comparator. The
    // debrid link cleared server-side media validation; `native1080` is an
    // unprobed embed. Ranking a rewrap of a known-good link below an unproven
    // one is how the Fight Club / Oppenheimer mis-picks happened.
    const mkv1080 = makeSource({
      id: "mkv-1080",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mkv",
      maxHeight: 1080,
    });
    expect(pickDefaultSource([mkv1080, native1080])?.id).toBe("mkv-1080");
  });

  it("still auto-plays when every source needs a remux", () => {
    expect(pickDefaultSource([mkv4k])?.id).toBe("mkv-4k");
  });

  it("returns no default when the only source is undecodable in this browser", () => {
    const hevc4k = makeSource({
      id: "hevc-4k-only",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "hevc",
      container: "mkv",
      maxHeight: 2160,
    });
    expect(pickDefaultSource([hevc4k])).toBeNull();
  });

  it("sinks an undecodable source below a playable one in the manual picker, without hiding it", () => {
    const hevc4k = makeSource({
      id: "hevc-4k",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "hevc",
      container: "mkv",
      maxHeight: 2160,
    });
    const sorted = sortSourcesForPicker([hevc4k, native1080]);
    expect(sorted.map((s) => s.id)).toEqual(["native-1080", "hevc-4k"]);
  });

  it("orders the picker the same way the auto-pick does, so the top row is the one that plays", () => {
    const sorted = sortSourcesForPicker([native1080, mkv4k]);
    expect(sorted[0]?.id).toBe("mkv-4k");
    expect(sorted.map((s) => s.id)).toEqual(["mkv-4k", "native-1080"]);
  });

  it("never auto-upgrades a running stream into a remux mid-playback", () => {
    // isFasterSource fires DURING playback; interrupting a working stream to
    // start a server-side rewrap is not an upgrade the viewer asked for.
    expect(isFasterSource(native1080, mkv4k)).toBe(false);
  });
});

describe("pickDefaultSource — poison gate", () => {
  it("never auto-defaults abuse mp4 when clean HLS exists", () => {
    const abuse = makeSource({
      id: "abuse",
      url: "https://cloudflare-terms-of-service-abuse.com/stream.mp4",
      label: "Share",
      provider: "Fshare",
      type: "mp4",
      maxHeight: 1080,
      probe: { ok: true, ttfbMs: 20, bytesPerSec: 9_000_000, speedScore: 99 },
      verified: true,
    });
    const luna = makeSource({
      id: "luna",
      url: "https://moon.ironwallnet.net/hls/movie/abc/index.m3u8",
      label: "Luna",
      provider: "Vixsrc",
      type: "hls",
      maxHeight: 720,
      verified: true,
    });
    expect(pickDefaultSource([abuse, luna])?.id).toBe("luna");
  });

  it("never auto-defaults hostinger php when solstice exists", () => {
    const php = makeSource({
      id: "php",
      url: "https://foo.hostingersite.com/vid1.php?id=99",
      label: "Pulse",
      provider: "notorrent",
      type: "mp4",
      maxHeight: 1080,
      verified: true,
    });
    const solstice = makeSource({
      id: "solstice",
      url: "https://moon.ironbubble.site/playlist/master.m3u8",
      label: "Solstice",
      provider: "Vidking",
      type: "hls",
      maxHeight: 1080,
      verified: true,
    });
    expect(pickDefaultSource([php, solstice])?.id).toBe("solstice");
  });

  it("only-poison roster still returns a pick (last resort)", () => {
    const a = makeSource({
      id: "a",
      url: "https://cloudflare-terms-of-service-abuse.com/a.mp4",
      type: "mp4",
      maxHeight: 1080,
    });
    const picked = pickDefaultSource([a]);
    expect(picked?.id).toBe("a");
  });
});

describe("resolvePreferredHeightTarget / preferred-height scoring (Change 11)", () => {
  it("auto and null hunt 4K while explicit HD stays capped", () => {
    expect(resolvePreferredHeightTarget("auto")).toBe(2160);
    expect(resolvePreferredHeightTarget(null)).toBe(2160);
    expect(resolvePreferredHeightTarget(undefined)).toBe(2160);
  });

  it("honours a lower explicit profile target without changing Auto's HD start", () => {
    expect(resolvePreferredHeightTarget(720)).toBe(720);
  });

  it("honours explicit 2160 preference", () => {
    expect(resolvePreferredHeightTarget(2160)).toBe(2160);
  });

  it("preferred 2160 ranks a known-4K source over a known-1080 one", () => {
    const s1080 = makeSource({ id: "s1080", label: "Aether", maxHeight: 1080 });
    const s2160 = makeSource({ id: "s2160", label: "Horizon", maxHeight: 2160 });
    // Without preferred height, higher real res already wins — assert both paths.
    expect(pickDefaultSource([s1080, s2160])?.id).toBe("s2160");
    expect(pickDefaultSource([s1080, s2160], null, 2160)?.id).toBe("s2160");
    // 4K preferred still never loses to a sub-HD source.
    const sub = makeSource({
      id: "sub",
      label: "Luna",
      provider: "Vixsrc",
      maxHeight: 720,
      probe: { ok: true, ttfbMs: 20, bytesPerSec: 9_000_000, speedScore: 99 },
    });
    expect(pickDefaultSource([sub, s1080], null, 2160)?.id).toBe("s1080");
  });

  it("preferred auto still refuses known-sub-1080 when known-HD exists", () => {
    const sub = makeSource({ id: "sub", label: "Luna", maxHeight: 720 });
    const hd = makeSource({ id: "hd", label: "Aether", maxHeight: 1080 });
    expect(pickDefaultSource([sub, hd], null, "auto")?.id).toBe("hd");
  });

  it("preferred auto ranks a known 4K source over a known 1080p one", () => {
    const hd = makeSource({ id: "hd", label: "Aether", maxHeight: 1080 });
    const uhd = makeSource({ id: "uhd", label: "Horizon", maxHeight: 2160 });
    expect(pickDefaultSource([hd, uhd], null, "auto")?.id).toBe("uhd");
  });
});

describe("findNewSourceIds (Change 3)", () => {
  it("returns only ids not in the previous set", () => {
    const prev = new Set(["a", "b"]);
    const current = [
      makeSource({ id: "a" }),
      makeSource({ id: "b" }),
      makeSource({ id: "c" }),
      makeSource({ id: "d" }),
    ];
    expect(findNewSourceIds(prev, current)).toEqual(["c", "d"]);
  });

  it("returns empty when nothing new arrived", () => {
    const prev = new Set(["a"]);
    expect(findNewSourceIds(prev, [makeSource({ id: "a" })])).toEqual([]);
  });
});

describe("findQualityUpgradeSource (Change 12)", () => {
  const subPlaying = makeSource({
    id: "current-sub",
    label: "Luna",
    provider: "Vixsrc",
    maxHeight: 720,
  });
  const hd = makeSource({
    id: "hd",
    label: "Aether",
    provider: "CinePro",
    maxHeight: 1080,
  });

  it("upgrades when confirmed playing height is sub-1080 and a known-HD source exists", () => {
    const next = findQualityUpgradeSource(subPlaying, [subPlaying, hd], 720);
    expect(next?.id).toBe("hd");
  });

  it("does not upgrade on unknown (0) height", () => {
    expect(findQualityUpgradeSource(subPlaying, [subPlaying, hd], 0)).toBeNull();
  });

  it("does not upgrade when already at/above 1080", () => {
    expect(findQualityUpgradeSource(subPlaying, [subPlaying, hd], 1080)).toBeNull();
    expect(findQualityUpgradeSource(subPlaying, [subPlaying, hd], 1440)).toBeNull();
  });

  it("skips failed known-HD candidates", () => {
    expect(
      findQualityUpgradeSource(subPlaying, [subPlaying, hd], 480, ["hd"])
    ).toBeNull();
  });

  it("returns null when no known-HD source is in the roster", () => {
    const onlySub = [
      subPlaying,
      makeSource({ id: "other", label: "Nova", maxHeight: 480 }),
    ];
    expect(findQualityUpgradeSource(subPlaying, onlySub, 480)).toBeNull();
  });

  it("treats ladder[0] as known HD for the upgrade candidate", () => {
    const ladderHd = makeSource({
      id: "ladder-hd",
      label: "Horizon",
      ladder: [1080, 720],
    });
    const next = findQualityUpgradeSource(subPlaying, [subPlaying, ladderHd], 720);
    expect(next?.id).toBe("ladder-hd");
  });
});

describe("withDetectedSourceHeight (Change 10)", () => {
  it("sets maxHeight from confirmed decode for single-rendition sources", () => {
    const mp4 = makeSource({ id: "mp4", type: "mp4", maxHeight: 0 });
    const updated = withDetectedSourceHeight(mp4, 1080);
    expect(updated.maxHeight).toBe(1080);
    // Original props object is not mutated.
    expect(mp4.maxHeight).toBe(0);
  });

  it("does not overwrite multi-rendition ladder metadata with current play height", () => {
    const hls = makeSource({
      id: "hls",
      type: "hls",
      maxHeight: 2160,
      ladder: [2160, 1080, 720],
    });
    const updated = withDetectedSourceHeight(hls, 720);
    expect(updated).toBe(hls);
    expect(updated.maxHeight).toBe(2160);
  });
});

/**
 * R6 — weak height metadata. Scraper often stamps maxHeight:0 ("probed unknown").
 * That must fall through to quality/label/url tokens; pure unknown stays 0 and
 * still ranks above known sub-HD (never invent heights without tokens).
 */
describe("sourceMaxHeight / pickDefaultSource — R6 maxHeight:0 fall-through", () => {
  it("maxHeight:0 + quality auto + no tokens → height 0, ranks above known 480", () => {
    const unknown = makeSource({
      id: "unknown-auto",
      quality: "auto",
      maxHeight: 0,
      label: "Phoenix",
      provider: "VidLink",
      url: "https://cdn.example/playlist/abc.m3u8",
    });
    const known480 = makeSource({
      id: "known-480",
      quality: "480p",
      maxHeight: 480,
      label: "Luna",
      provider: "Vixsrc",
    });
    expect(sourceMaxHeight(unknown)).toBe(0);
    expect(sourceMaxHeight(known480)).toBe(480);
    // Unknown tier (0) above known sub-HD — stay playable when no real HD exists.
    const picked = pickDefaultSource([known480, unknown]);
    expect(picked?.id).toBe("unknown-auto");
  });

  it("maxHeight:0 + quality \"1080p\" → sourceMaxHeight 1080; preferred over maxHeight:720", () => {
    const tokenHd = makeSource({
      id: "token-1080",
      quality: "1080p",
      maxHeight: 0,
      label: "Share",
      provider: "Fshare",
    });
    const known720 = makeSource({
      id: "known-720",
      quality: "720p",
      maxHeight: 720,
      label: "Luna",
      provider: "Vixsrc",
      probe: { ok: true, ttfbMs: 40, bytesPerSec: 5_000_000, speedScore: 90 },
    });
    expect(sourceMaxHeight(tokenHd)).toBe(1080);
    expect(pickDefaultSource([known720, tokenHd])?.id).toBe("token-1080");
  });

  it("maxHeight:0 + url containing /1080/ → height 1080", () => {
    const urlToken = makeSource({
      id: "url-1080",
      quality: "auto",
      maxHeight: 0,
      label: "Solstice",
      provider: "Vidking",
      url: "https://cdn.example/1080/index.m3u8",
    });
    expect(sourceMaxHeight(urlToken)).toBe(1080);
    expect(parseMaxHeight("https://cdn.example/1080/index.m3u8")).toBe(1080);
  });

  it("maxHeight:0 + quality auto vs maxHeight:480 → unknown wins over 480", () => {
    const autoUnknown = makeSource({
      id: "auto-0",
      quality: "auto",
      maxHeight: 0,
      label: "Aether",
      provider: "CinePro",
      url: "https://cdn.example/master.m3u8",
    });
    const low = makeSource({
      id: "low-480",
      quality: "480p",
      maxHeight: 480,
      label: "Nova",
      provider: "embed.su",
    });
    expect(sourceMaxHeight(autoUnknown)).toBe(0);
    expect(pickDefaultSource([low, autoUnknown])?.id).toBe("auto-0");
  });

  it("explicit maxHeight:1080 still wins over token-only guess of lower", () => {
    const probed = makeSource({
      id: "probed-1080",
      quality: "720p",
      maxHeight: 1080,
      label: "Horizon",
      provider: "CinePro",
      url: "https://cdn.example/720/master.m3u8",
    });
    const tokenOnly = makeSource({
      id: "token-720",
      quality: "720p",
      maxHeight: 0,
      label: "Share 720p",
      provider: "Fshare",
      url: "https://cdn.example/720/file.mp4",
    });
    // Probed positive maxHeight wins over quality/url tokens on the same source.
    expect(sourceMaxHeight(probed)).toBe(1080);
    expect(sourceMaxHeight(tokenOnly)).toBe(720);
    expect(pickDefaultSource([tokenOnly, probed])?.id).toBe("probed-1080");
  });

  it("ladder[0] outranks a conflicting lower maxHeight stamp", () => {
    const src = makeSource({
      id: "ladder-wins",
      maxHeight: 720,
      ladder: [1080, 720, 480],
    });
    expect(sourceMaxHeight(src)).toBe(1080);
  });

  it("never invents height from opaque urls when maxHeight is 0", () => {
    const opaque = makeSource({
      id: "opaque",
      quality: "auto",
      maxHeight: 0,
      label: "Server",
      provider: "Test",
      url: "https://cdn.example/playlist/320744abc.m3u8",
    });
    expect(sourceMaxHeight(opaque)).toBe(0);
  });
});

/**
 * Browser-aware auto-default / honesty (ranking-ux pass). Tests run under
 * bun (no `window`/`document`), matching Chrome-without-HEVC-support — same
 * convention as debrid/ranking.test.ts.
 */
describe("isSourcePlayableHere", () => {
  it("false for a Safari-only compat release when this browser can't decode HEVC", () => {
    const safariOnly = makeSource({
      id: "safari-only",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 2160,
    });
    expect(isSourcePlayableHere(safariOnly)).toBe(false);
  });

  it("true for a native-compat debrid release", () => {
    const native = makeSource({
      id: "native",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      maxHeight: 2160,
    });
    expect(isSourcePlayableHere(native)).toBe(true);
  });

  it("true for embed sources (no compat field — always treated as natively playable)", () => {
    const embed = makeSource({ id: "embed" });
    expect(isSourcePlayableHere(embed)).toBe(true);
  });

  /**
   * AV1 gap (review fix): AV1-in-MP4 has the OPPOSITE browser affinity from
   * HEVC (Chrome/Firefox-native, unreliable on older Safari) — gating must
   * be codec-first and INDEPENDENT of whatever `compat` the RD agent stamps
   * on it, never routed through the HEVC/Safari check. Tests run under bun
   * (no `window`/`document`) — `browserSupportsAv1()` is always false here,
   * same "capability absent" baseline as the existing HEVC tests.
   */
  it("false for codec:\"av1\" in this no-AV1-capability env, even when compat says \"native\"", () => {
    const av1Native = makeSource({
      id: "av1-native",
      origin: "debrid",
      compat: "native",
      codec: "av1",
      maxHeight: 2160,
    });
    expect(isSourcePlayableHere(av1Native)).toBe(false);
  });

  it("false for codec:\"av1\" even when compat says \"safari\" — codec gate wins, not compat", () => {
    const av1Safari = makeSource({
      id: "av1-safari",
      origin: "debrid",
      compat: "safari",
      codec: "av1",
      maxHeight: 2160,
    });
    expect(isSourcePlayableHere(av1Safari)).toBe(false);
  });

  it("codec:\"h264\"/\"unknown\" are unaffected by the AV1 gate (native/all browsers)", () => {
    const h264 = makeSource({ id: "h264", origin: "debrid", compat: "native", codec: "h264" });
    const unknown = makeSource({ id: "unknown-codec", origin: "debrid", compat: "native", codec: "unknown" });
    expect(isSourcePlayableHere(h264)).toBe(true);
    expect(isSourcePlayableHere(unknown)).toBe(true);
  });

  /**
   * MKV/WebM open in NO browser, Safari included, whatever the codec inside —
   * so they are never "direct". But the container is the ONLY problem when the
   * streams inside decode here, and rewrapping to fMP4 is a stream copy, so
   * they are "remux" rather than dead inventory. This is the pair of rows that
   * used to be dropped entirely and is the reason 4K never appeared.
   */
  it("container mkv/webm -> remux (never direct, never discarded) when the codec decodes here", () => {
    const mkvNativeH264 = makeSource({
      id: "mkv-h264-native",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mkv",
      maxHeight: 1080,
    });
    const webmNativeH264 = makeSource({
      id: "webm-h264-native",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "webm",
      maxHeight: 1080,
    });
    expect(sourceDelivery(mkvNativeH264)).toBe("remux");
    expect(sourceDelivery(webmNativeH264)).toBe("remux");
    expect(isSourcePlayableHere(mkvNativeH264)).toBe(true);
    expect(isSourcePlayableHere(webmNativeH264)).toBe(true);
  });

  /**
   * The container fix must not paper over a codec this browser cannot decode:
   * rewrapping HEVC into MP4 still leaves HEVC, which Chrome cannot decode in
   * any wrapper. Codec is checked first, and it is decisive.
   */
  it("an undecodable codec stays unavailable even in a remuxable container", () => {
    const hevcMkv = makeSource({
      id: "hevc-mkv",
      origin: "debrid",
      compat: "native",
      codec: "hevc",
      container: "mkv",
      maxHeight: 2160,
    });
    // No window/MediaSource under the test runtime -> HEVC unsupported.
    expect(sourceDelivery(hevcMkv)).toBe("unavailable");
    expect(isSourcePlayableHere(hevcMkv)).toBe(false);
  });

  it("container mp4/mov/unknown never trip the container gate — falls through to the existing codec/compat logic", () => {
    const mp4Native = makeSource({
      id: "mp4-native",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mp4",
      maxHeight: 1080,
    });
    const unknownContainer = makeSource({
      id: "unknown-container",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "unknown",
      maxHeight: 1080,
    });
    expect(isSourcePlayableHere(mp4Native)).toBe(true);
    expect(isSourcePlayableHere(unknownContainer)).toBe(true);
  });
});

describe("qualityBadge — browser compatibility honesty", () => {
  it('appends "· unavailable" for a compat:"safari" source this browser can\'t decode natively', () => {
    const safariOnly = makeSource({
      id: "safari-4k",
      provider: "Debrid",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 2160,
    });
    expect(qualityBadge(safariOnly)).toBe("4K · unavailable (Debrid)");
  });

  it("never tags a native-compat or embed source, and keeps the real height", () => {
    const native = makeSource({
      id: "native-4k",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      maxHeight: 2160,
    });
    expect(qualityBadge(native)).toBe("4K (Debrid)");
    const embed = makeSource({ id: "embed-1080", maxHeight: 1080 });
    expect(qualityBadge(embed)).toBe("1080p");
  });

  it('appends "· unavailable" for an unplayable-here codec:"av1" release too', () => {
    const av1 = makeSource({
      id: "av1-4k",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "av1",
      maxHeight: 2160,
    });
    expect(qualityBadge(av1)).toBe("4K · unavailable (Debrid)");
  });

  it('an MKV source badges its real height with no unavailable tag — it remuxes and plays', () => {
    const mkv = makeSource({
      id: "mkv-4k",
      provider: "Debrid",
      origin: "debrid",
      compat: "native",
      codec: "h264",
      container: "mkv",
      maxHeight: 2160,
    });
    expect(qualityBadge(mkv)).toBe("4K (Debrid)");
  });

  it("an unavailable 720p source keeps its real height", () => {
    const safariOnly720 = makeSource({
      id: "safari-720",
      provider: "Debrid",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 720,
    });
    expect(qualityBadge(safariOnly720)).toBe("720p · unavailable (Debrid)");
  });
});

describe("sortSourcesForPicker — playable-here-first honesty (Server list)", () => {
  it("a Safari-only 4K debrid source sorts below a native 1080p one, even with a better probe", () => {
    const safariOnly4k = makeSource({
      id: "safari-4k",
      label: "Real-Debrid",
      provider: "Debrid",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 2160,
      verified: true,
      probe: { ok: true, ttfbMs: 20, bytesPerSec: 9_000_000, speedScore: 99 },
    });
    const native1080 = makeSource({
      id: "native-1080",
      label: "Aether",
      provider: "CinePro",
      maxHeight: 1080,
    });
    const sorted = sortSourcesForPicker([safariOnly4k, native1080]);
    expect(sorted.map((s) => s.id)).toEqual(["native-1080", "safari-4k"]);
  });

  it("still lists the unplayable-here source (never hidden — only sorted below)", () => {
    const safariOnly = makeSource({ id: "safari-only", origin: "debrid", compat: "safari", codec: "hevc" });
    const sorted = sortSourcesForPicker([safariOnly]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]?.id).toBe("safari-only");
  });
});

describe("findQualityUpgradeSource — never upgrades to an unplayable-here source", () => {
  it("skips a known-HD Safari-only debrid candidate and returns null when nothing else qualifies", () => {
    const subPlaying = makeSource({ id: "current-sub", label: "Luna", maxHeight: 720 });
    const safariOnlyHd = makeSource({
      id: "safari-hd",
      label: "Real-Debrid",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 2160,
    });
    expect(
      findQualityUpgradeSource(subPlaying, [subPlaying, safariOnlyHd], 720)
    ).toBeNull();
  });

  it("still upgrades to a playable-here known-HD candidate when both exist", () => {
    const subPlaying = makeSource({ id: "current-sub", label: "Luna", maxHeight: 720 });
    const safariOnlyHd = makeSource({
      id: "safari-hd",
      label: "Real-Debrid",
      origin: "debrid",
      compat: "safari",
      codec: "hevc",
      maxHeight: 2160,
    });
    const nativeHd = makeSource({ id: "native-hd", label: "Aether", maxHeight: 1080 });
    const next = findQualityUpgradeSource(
      subPlaying,
      [subPlaying, safariOnlyHd, nativeHd],
      720
    );
    expect(next?.id).toBe("native-hd");
  });
});

describe("sourceDelivery - audio safety", () => {
  it("keeps a single-track AAC MP4 direct", () => {
    expect(
      sourceDelivery(
        makeSource({
          id: "aac-direct",
          origin: "debrid",
          codec: "h264",
          container: "mp4",
          audioCodec: "aac",
        })
      )
    ).toBe("direct");
  });

  it("remuxes unsupported audio while copying compatible video", () => {
    expect(
      sourceDelivery(
        makeSource({
          id: "dts-remux",
          origin: "debrid",
          codec: "h264",
          container: "mp4",
          audioCodec: "dts",
        })
      )
    ).toBe("remux");
  });

  it("remuxes debrid multi-audio so language selection is deterministic", () => {
    expect(
      sourceDelivery(
        makeSource({
          id: "dual-audio-remux",
          origin: "debrid",
          codec: "h264",
          container: "mp4",
          audioCodec: "aac",
          multiAudio: true,
        })
      )
    ).toBe("remux");
  });
});
