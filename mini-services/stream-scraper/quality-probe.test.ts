/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  classifyStreamKind,
  inferHeightFromUrl,
  isHlsMasterManifest,
  isHlsMediaManifest,
  parseDashLadder,
  parseHlsMasterLadder,
  type QualityInfo,
  type QualitySource,
} from "./quality-probe";

/** Local pure helpers mirrored from probeQualityOne branching for unit coverage. */
function qualitySourceFromHlsMaster(ladder: number[], tokenHeight: number): QualitySource {
  if (ladder.length > 0) return "manifest";
  if (tokenHeight > 0) return "label";
  return "unknown";
}

function qualitySourceFromMediaPlaylist(tokenHeight: number): QualitySource {
  return tokenHeight > 0 ? "probe" : "unknown";
}

function ensureMaxFromLadder(info: Pick<QualityInfo, "maxHeight" | "ladder" | "qualitySource">) {
  if (info.ladder.length > 0 && (info.maxHeight <= 0 || info.maxHeight < info.ladder[0]!)) {
    return { ...info, maxHeight: info.ladder[0]! };
  }
  return info;
}

describe("parseHlsMasterLadder", () => {
  it("extracts unique heights descending", () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
hi-dup.m3u8
`;
    expect(parseHlsMasterLadder(text)).toEqual([1080, 720, 360]);
  });

  it("returns empty for media playlists", () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
`;
    expect(parseHlsMasterLadder(text)).toEqual([]);
  });
});

describe("parseDashLadder", () => {
  it("collects height attrs descending", () => {
    const mpd = `<MPD><Representation height="720"/><Representation height="1080"/><Representation height="720"/></MPD>`;
    expect(parseDashLadder(mpd)).toEqual([1080, 720]);
  });
});

describe("manifest classifiers", () => {
  it("detects master vs media", () => {
    expect(isHlsMasterManifest("#EXT-X-STREAM-INF:RESOLUTION=1280x720\n")).toBe(true);
    expect(isHlsMediaManifest("#EXTINF:4.0,\nseg.ts\n")).toBe(true);
    expect(isHlsMasterManifest("#EXTINF:4.0,\nseg.ts\n")).toBe(false);
  });
});

describe("qualitySource provenance", () => {
  it("master ladder → manifest", () => {
    expect(qualitySourceFromHlsMaster([1080, 720], 0)).toBe("manifest");
    expect(qualitySourceFromHlsMaster([720], 1080)).toBe("manifest");
  });

  it("empty master ladder + token → label", () => {
    expect(qualitySourceFromHlsMaster([], 1080)).toBe("label");
  });

  it("empty master ladder + no token → unknown", () => {
    expect(qualitySourceFromHlsMaster([], 0)).toBe("unknown");
  });

  it("media playlist with token height → probe", () => {
    expect(qualitySourceFromMediaPlaylist(1080)).toBe("probe");
    expect(qualitySourceFromMediaPlaylist(0)).toBe("unknown");
  });

  it("always sets maxHeight from ladder[0] when known", () => {
    const fixed = ensureMaxFromLadder({
      maxHeight: 0,
      ladder: [1080, 720],
      qualitySource: "manifest",
    });
    expect(fixed.maxHeight).toBe(1080);
    expect(fixed.qualitySource).toBe("manifest");
  });

  it("does not lower maxHeight below ladder top", () => {
    const fixed = ensureMaxFromLadder({
      maxHeight: 720,
      ladder: [1080, 720],
      qualitySource: "manifest",
    });
    expect(fixed.maxHeight).toBe(1080);
  });
});

describe("cheap classify + height tokens", () => {
  it("classifies kind without network", () => {
    expect(classifyStreamKind("https://x/a.m3u8")).toBe("hls");
    expect(classifyStreamKind("https://x/a.mp4")).toBe("mp4");
    expect(classifyStreamKind("https://x/a.mpd")).toBe("dash");
    expect(classifyStreamKind("https://x/proxy", "Share", "mp4")).toBe("mp4");
  });

  it("infers label-only heights used as qualitySource=label", () => {
    expect(inferHeightFromUrl("https://cdn.example/1080p/index.m3u8")).toBe(1080);
    expect(inferHeightFromUrl("Share 2160p")).toBe(2160);
    expect(inferHeightFromUrl("https://cdn.example/playlist/abc.m3u8")).toBe(0);
  });
});

/**
 * R6 — when network ladder is empty but URL/label/quality has a token, stamp
 * maxHeight + qualitySource "label". Never invent without a token.
 * Mirrors probeQualityOne fall-through after failed/empty fetch.
 */
function qualityFromEmptyNetwork(tokenHeight: number): {
  maxHeight: number;
  ladder: number[];
  qualitySource: QualitySource;
} {
  if (tokenHeight > 0) {
    return { maxHeight: tokenHeight, ladder: [], qualitySource: "label" };
  }
  return { maxHeight: 0, ladder: [], qualitySource: "unknown" };
}

describe("R6 empty-network ladder + token fall-through", () => {
  it("token height → qualitySource label (not unknown)", () => {
    const info = qualityFromEmptyNetwork(
      inferHeightFromUrl("https://cdn.example/1080/index.m3u8 Share 1080p")
    );
    expect(info.maxHeight).toBe(1080);
    expect(info.ladder).toEqual([]);
    expect(info.qualitySource).toBe("label");
  });

  it("no token → stays unknown, maxHeight 0", () => {
    const info = qualityFromEmptyNetwork(
      inferHeightFromUrl("https://cdn.example/playlist/abc.m3u8 auto")
    );
    expect(info.maxHeight).toBe(0);
    expect(info.qualitySource).toBe("unknown");
  });

  it("master empty ladder still prefers label token over unknown", () => {
    expect(qualitySourceFromHlsMaster([], 1080)).toBe("label");
    expect(qualitySourceFromHlsMaster([], 0)).toBe("unknown");
  });
});
