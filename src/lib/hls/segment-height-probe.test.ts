/// <reference types="bun-types" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  extractHeightFromSegmentPrefix,
  firstMediaSegmentUri,
  isPureHlsMediaPlaylist,
  isHlsMasterPlaylist,
  looksLikeMultiVariantChildUrl,
  normalizeLadderHeight,
  probeSegmentHeight,
  resolvePlaylistUri,
  shouldWrapPureMedia,
  wrapMediaPlaylistAsMaster,
} from "./segment-height-probe";

describe("wrapMediaPlaylistAsMaster (Change 7)", () => {
  it("emits STREAM-INF with RESOLUTION for known height", () => {
    const out = wrapMediaPlaylistAsMaster("/api/hls/s?u=abc&media=1", 1080, 5_000_000);
    expect(out).toContain("#EXT-X-STREAM-INF:");
    expect(out).toContain("RESOLUTION=1920x1080");
    expect(out).toContain("/api/hls/s?u=abc&media=1");
    expect(isHlsMasterPlaylist(out)).toBe(true);
  });

  it("defaults missing height to 1080 for wrap (caller should only wrap when known)", () => {
    const out = wrapMediaPlaylistAsMaster("media.m3u8", 0);
    expect(out).toContain("RESOLUTION=1920x1080");
  });
});

describe("isPureHlsMediaPlaylist", () => {
  it("detects media-only playlists", () => {
    const media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n";
    expect(isPureHlsMediaPlaylist(media)).toBe(true);
    expect(isHlsMasterPlaylist(media)).toBe(false);
  });

  it("rejects masters", () => {
    const master =
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8\n";
    expect(isPureHlsMediaPlaylist(master)).toBe(false);
    expect(isHlsMasterPlaylist(master)).toBe(true);
  });
});

describe("shouldWrapPureMedia (R10)", () => {
  it("allows wrap for pure-media root URLs without variant signals", () => {
    expect(shouldWrapPureMedia("https://cdn.example/vod/playlist.m3u8", false)).toBe(true);
    expect(looksLikeMultiVariantChildUrl("https://cdn.example/vod/playlist.m3u8")).toBe(false);
  });

  it("blocks wrap for Vixsrc-style rendition= children", () => {
    const url =
      "https://sc.vix-content.net/p?type=video&rendition=1080p&expires=1";
    expect(looksLikeMultiVariantChildUrl(url)).toBe(true);
    expect(shouldWrapPureMedia(url, false)).toBe(false);
  });

  it("blocks wrap when skipMediaWrap is set (media=1)", () => {
    expect(shouldWrapPureMedia("https://cdn.example/vod/playlist.m3u8", true)).toBe(false);
  });

  it("blocks wrap for quality-folder and index-sNp paths", () => {
    expect(looksLikeMultiVariantChildUrl("https://cdn.example/a/1080/index.m3u8")).toBe(
      true
    );
    expect(looksLikeMultiVariantChildUrl("https://cdn.example/a/index-s720p.m3u8")).toBe(
      true
    );
    expect(shouldWrapPureMedia("https://cdn.example/a/480p/chunklist.m3u8", false)).toBe(
      false
    );
    expect(shouldWrapPureMedia("https://cdn.example/a/320/index.m3u8", false)).toBe(
      false
    );
  });
});

describe("firstMediaSegmentUri + resolvePlaylistUri", () => {
  it("picks first non-tag line", () => {
    const text = "#EXTM3U\n#EXTINF:4,\n./a/seg1.ts\n#EXTINF:4,\n./a/seg2.ts\n";
    expect(firstMediaSegmentUri(text)).toBe("./a/seg1.ts");
  });

  it("resolves relative against base", () => {
    expect(resolvePlaylistUri("https://cdn.example/hls/index.m3u8", "seg0.ts")).toBe(
      "https://cdn.example/hls/seg0.ts"
    );
  });
});

describe("normalizeLadderHeight", () => {
  it("snaps near-standard heights", () => {
    expect(normalizeLadderHeight(1072)).toBe(1080);
    expect(normalizeLadderHeight(720)).toBe(720);
    expect(normalizeLadderHeight(320)).toBe(320);
    expect(normalizeLadderHeight(900)).toBe(900);
  });
});

describe("extractHeightFromSegmentPrefix", () => {
  it("returns 0 for empty/short buffers", () => {
    expect(extractHeightFromSegmentPrefix(new Uint8Array(8))).toBe(0);
  });

  it("reads height from synthetic avc1 sample entry", () => {
    // Minimal buffer with "avc1" fourcc and height 1080 at entry+26/27
    // entryStart = i-4 where i is index of 'a' in avc1
    const buf = new Uint8Array(64);
    // place size(4) + type avc1 at offset 10
    const entryStart = 10;
    buf[entryStart] = 0;
    buf[entryStart + 1] = 0;
    buf[entryStart + 2] = 0;
    buf[entryStart + 3] = 50; // size
    buf[entryStart + 4] = 0x61; // a
    buf[entryStart + 5] = 0x76; // v
    buf[entryStart + 6] = 0x63; // c
    buf[entryStart + 7] = 0x31; // 1
    // height at entryStart+26
    buf[entryStart + 26] = 0x04; // 1080 = 0x0438
    buf[entryStart + 27] = 0x38;
    const h = extractHeightFromSegmentPrefix(buf);
    expect(h).toBe(1080);
  });
});

describe("probeSegmentHeight — hung upstream / graceful fail-open", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it("returns 0 when Range GET hangs past timeout (abort path)", async () => {
    // Fault inject: never resolve body — only abort via signal should finish the probe.
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true }
        );
        // Intentionally never resolve — simulates hung CDN on Range bytes=0-N.
      });
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    const height = await probeSegmentHeight("https://cdn.example/seg0.ts", {
      timeoutMs: 40,
    });
    const elapsed = Date.now() - t0;
    expect(height).toBe(0);
    // Must not block far past timeout (grace for timer scheduling).
    expect(elapsed).toBeLessThan(500);
  });

  it("returns 0 when fetch throws network error (caller keeps original m3u8)", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const height = await probeSegmentHeight("https://cdn.example/seg0.ts", {
      timeoutMs: 100,
    });
    expect(height).toBe(0);
  });

  it("returns 0 when outer AbortSignal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const height = await probeSegmentHeight("https://cdn.example/seg0.ts", {
      signal: ac.signal,
      timeoutMs: 200,
    });
    expect(height).toBe(0);
  });
});
