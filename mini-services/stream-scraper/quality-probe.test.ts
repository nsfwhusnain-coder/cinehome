/// <reference types="bun-types" />
import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  classifyStreamKind,
  inferHeightFromUrl,
  isHlsMasterManifest,
  isHlsMediaManifest,
  parseDashLadder,
  parseDashTopBitrate,
  parseHlsMasterLadder,
  parseHlsMasterRenditions,
  parseMp4Dimensions,
  probeSourceQuality,
  type QualityInfo,
  type QualitySession,
  type QualitySource,
} from "./quality-probe";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function isoBox(type: string, payload: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + payload.byteLength);
  writeUint32(box, 0, box.byteLength);
  for (let index = 0; index < 4; index++) box[4 + index] = type.charCodeAt(index);
  box.set(payload, 8);
  return box;
}

function tkhdBox(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(84);
  writeUint32(payload, 76, width * 65_536);
  writeUint32(payload, 80, height * 65_536);
  return isoBox("tkhd", payload);
}

function progressiveMp4(width: number, height: number, mediaBytes: number): Uint8Array {
  const ftyp = isoBox("ftyp", new Uint8Array(8));
  const mdat = isoBox("mdat", new Uint8Array(mediaBytes));
  const moov = isoBox("moov", isoBox("trak", tkhdBox(width, height)));
  return concatBytes(ftyp, mdat, moov);
}

const MP4_SESSION: QualitySession = {
  referer: "https://app.example/watch",
  origin: "https://app.example",
  userAgent: "CineHome quality test",
  cookies: "session=authorized",
  extraHeaders: { Authorization: "Bearer private-media" },
};

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

  it("normalizes cropped cinema rasters by width", () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x1600
uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x800
hd.m3u8
`;
    expect(parseHlsMasterLadder(text)).toEqual([2160, 1080]);
    expect(parseHlsMasterRenditions(text).map((rendition) => rendition.height)).toEqual([
      2160,
      1080,
    ]);
  });
});

describe("parseDashLadder", () => {
  it("collects height attrs descending", () => {
    const mpd = `<MPD><Representation height="720"/><Representation height="1080"/><Representation height="720"/></MPD>`;
    expect(parseDashLadder(mpd)).toEqual([1080, 720]);
  });

  it("uses only video Representations and pairs bitrate with the top rung", () => {
    const mpd = `<MPD>
<AdaptationSet contentType="audio">
  <Representation height="2160" bandwidth="24000000" codecs="mp4a.40.2"/>
</AdaptationSet>
<AdaptationSet contentType="video">
  <Representation width="1920" height="1080" bandwidth="12000000"/>
  <Representation width="3840" height="1600" bandwidth="8000000"/>
</AdaptationSet>
</MPD>`;
    expect(parseDashLadder(mpd)).toEqual([2160, 1080]);
    expect(parseDashTopBitrate(mpd)).toBe(8_000_000);
  });

  it("does not attach a lower rung bitrate when the top rung omits it", () => {
    const mpd = `<MPD><AdaptationSet contentType="video">
  <Representation width="1920" height="1080" bandwidth="12000000"/>
  <Representation width="3840" height="1600"/>
</AdaptationSet></MPD>`;
    expect(parseDashLadder(mpd)).toEqual([2160, 1080]);
    expect(parseDashTopBitrate(mpd)).toBe(0);
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
    expect(classifyStreamKind("https://x/opaque", "Cinema", "auto", "mp4")).toBe("mp4");
    expect(classifyStreamKind("https://x/file.mp4", "Cinema", "auto", "hls")).toBe("hls");
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

describe("opaque progressive MP4 metadata", () => {
  it("parses real ISO-BMFF tkhd fixed-point dimensions", () => {
    const bytes = progressiveMp4(3840, 2160, 32);
    expect(parseMp4Dimensions(bytes)).toEqual({ width: 3840, height: 2160 });
    expect(parseMp4Dimensions(new TextEncoder().encode("tkhd 3840x2160"))).toBeNull();
  });

  it("uses authorized head/tail ranges to identify an opaque 4K MP4", async () => {
    const url = "https://media.example/authorized?id=asset-a";
    const file = progressiveMp4(3840, 2160, 300_000);
    const ranges: string[] = [];
    const requestHeaders: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const range = headers.get("range") ?? "";
      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) throw new Error(`Unexpected range: ${range}`);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), file.byteLength - 1);
      ranges.push(range);
      requestHeaders.push(headers);
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${file.byteLength}` },
      });
    }) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Share",
      quality: "mp4",
      provider: "authorized-test",
      session: MP4_SESSION,
    }]);

    expect(result.get(url)).toEqual({
      type: "mp4",
      maxHeight: 2160,
      ladder: [],
      qualitySource: "probe",
    });
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toStartWith("bytes=0-");
    expect(requestHeaders[0]?.get("authorization")).toBe("Bearer private-media");
    expect(requestHeaders[0]?.get("cookie")).toBe("session=authorized");
  });

  it("honors declared MP4 type for an extensionless progressive URL", async () => {
    const url = "https://media.example/authorized?id=declared-progressive";
    const file = progressiveMp4(3840, 2160, 32);
    let requestedRange = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedRange = new Headers(init?.headers).get("range") ?? "";
      return new Response(file.slice(), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${file.byteLength - 1}/${file.byteLength}` },
      });
    }) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Cinema",
      quality: "auto",
      provider: "declared-mp4-test",
      session: MP4_SESSION,
      type: "mp4",
    }]);

    expect(requestedRange).toStartWith("bytes=0-");
    expect(result.get(url)).toMatchObject({
      type: "mp4",
      maxHeight: 2160,
      qualitySource: "probe",
    });
  });

  it("Ultra verifies and corrects a cached lower-labelled MP4", async () => {
    const url = "https://media.example/authorized?id=mislabeled-progressive";
    const entry = {
      url,
      label: "Cinema 1080p",
      quality: "1080p",
      provider: "mislabeled-mp4-test",
      session: MP4_SESSION,
      type: "mp4" as const,
    };
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetches++;
      throw new Error("default-quality MP4 must stay on the label fast path");
    }) as unknown as typeof fetch;
    expect((await probeSourceQuality([entry])).get(url)).toMatchObject({
      maxHeight: 1080,
      qualitySource: "label",
    });
    expect(fetches).toBe(0);

    const file = progressiveMp4(3840, 2160, 32);
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetches++;
      return new Response(file.slice(), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${file.byteLength - 1}/${file.byteLength}` },
      });
    }) as typeof fetch;
    const corrected = await probeSourceQuality([entry], { preferredHeight: 2160 });

    expect(fetches).toBe(1);
    expect(corrected.get(url)).toMatchObject({
      type: "mp4",
      maxHeight: 2160,
      qualitySource: "probe",
    });
  });

  it("caps and cancels the body when a server ignores Range", async () => {
    const url = "https://media.example/authorized?id=range-ignored";
    let fetches = 0;
    let pulls = 0;
    let cancelled = false;
    let requestedRange = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetches++;
      requestedRange = new Headers(init?.headers).get("range") ?? "";
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16_384));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Share",
      quality: "mp4",
      provider: "range-ignored-test",
      session: MP4_SESSION,
    }]);

    expect(result.get(url)?.maxHeight).toBe(0);
    expect(fetches).toBe(1);
    expect(requestedRange).toStartWith("bytes=0-");
    expect(pulls).toBeLessThan(64);
    expect(cancelled).toBe(true);
  });

  it("aborts a hung MP4 Range request at the probe time cap", async () => {
    jest.useFakeTimers();
    try {
      const url = "https://media.example/authorized?id=hung-range";
      let abortObserved = false;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        })) as typeof fetch;

      const pending = probeSourceQuality([{
        url,
        label: "Share",
        quality: "mp4",
        provider: "hung-range-test",
        session: MP4_SESSION,
      }]);
      await Promise.resolve();
      jest.advanceTimersByTime(3_000);

      expect((await pending).get(url)?.maxHeight).toBe(0);
      expect(abortObserved).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("measures a late opaque candidate before already-known 1080 entries", async () => {
    const opaqueUrl = "https://media.example/authorized?id=late-opaque";
    const opaqueFile = progressiveMp4(3840, 2160, 32);
    const knownEntries = Array.from({ length: 12 }, (_, index) => ({
      url: `https://known-${index}.example/1080/stream.m3u8`,
      label: "Known 1080p",
      quality: "1080p",
      provider: `known-${index % 2}`,
      session: MP4_SESSION,
    }));
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === opaqueUrl) {
        return new Response(opaqueFile.slice(), {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${opaqueFile.byteLength - 1}/${opaqueFile.byteLength}`,
          },
        });
      }
      return new Response(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhi.m3u8\n"
      );
    }) as typeof fetch;

    const result = await probeSourceQuality([
      ...knownEntries,
      {
        url: opaqueUrl,
        label: "Share",
        quality: "mp4",
        provider: "opaque-provider",
        session: MP4_SESSION,
      },
    ]);

    expect(requested).toHaveLength(12);
    expect(requested).toContain(opaqueUrl);
    expect(result.get(opaqueUrl)).toMatchObject({
      type: "mp4",
      maxHeight: 2160,
      qualitySource: "probe",
    });
  });
});

describe("bounded complete DASH metadata", () => {
  it("reads a complete MPD beyond the former 24 KB prefix", async () => {
    const url = "https://media.example/authorized?id=large-complete-mpd";
    const mpd = `<MPD>${" ".repeat(40_000)}
<AdaptationSet contentType="video">
  <Representation width="1920" height="1080" bandwidth="12000000"/>
  <Representation width="3840" height="1600" bandwidth="8000000"/>
</AdaptationSet>
</MPD>`;
    let requestedRange = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedRange = new Headers(init?.headers).get("range") ?? "";
      return new Response(mpd);
    }) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Cinema DASH",
      quality: "auto",
      provider: "large-dash-test",
      session: MP4_SESSION,
      type: "dash",
    }]);

    expect(result.get(url)).toMatchObject({
      type: "dash",
      maxHeight: 2160,
      ladder: [2160, 1080],
      bitrateBps: 8_000_000,
      qualitySource: "manifest",
    });
    expect(requestedRange).toStartWith("bytes=0-");
  });

  it("rejects and cancels a declared MPD larger than the hard cap", async () => {
    const url = "https://media.example/authorized?id=oversized-mpd";
    let cancelled = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            '<MPD><Representation width="3840" height="2160" bandwidth="8000000"/>'
          ));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Length": "600000" } }
    )) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Cinema DASH",
      quality: "auto",
      provider: "oversized-dash-test",
      session: MP4_SESSION,
      type: "dash",
    }]);

    expect(result.get(url)).toMatchObject({
      type: "dash",
      maxHeight: 0,
      qualitySource: "unknown",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects a complete response whose MPD XML is truncated", async () => {
    const url = "https://media.example/authorized?id=truncated-mpd";
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(`<MPD><AdaptationSet contentType="video">
  <Representation width="3840" height="1600" bandwidth="8000000"/>`)) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Cinema DASH",
      quality: "auto",
      provider: "truncated-dash-test",
      session: MP4_SESSION,
      type: "dash",
    }]);

    expect(result.get(url)).toMatchObject({
      type: "dash",
      maxHeight: 0,
      qualitySource: "unknown",
    });
  });
});

describe("bounded complete HLS metadata", () => {
  it("cancels an oversized body when the server ignores Range", async () => {
    const url = "https://media.example/authorized?id=oversized-hls";
    const manifest = new TextEncoder().encode(
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160\nuhd.m3u8\n"
    );
    let pulls = 0;
    let cancelled = false;
    let requestedRange = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedRange = new Headers(init?.headers).get("range") ?? "";
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(pulls++ === 0 ? manifest : new Uint8Array(16_384));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await probeSourceQuality([{
      url,
      label: "Cinema HLS",
      quality: "auto",
      provider: "oversized-hls-test",
      session: MP4_SESSION,
      type: "hls",
    }]);

    expect(result.get(url)).toMatchObject({
      type: "hls",
      maxHeight: 0,
      qualitySource: "unknown",
    });
    expect(requestedRange).toStartWith("bytes=0-");
    expect(pulls).toBeLessThan(64);
    expect(cancelled).toBe(true);
  });
});
