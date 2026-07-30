/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isMasterPlaylist, rewritePlaylist } from "./transcode-playlist";

const KEY = "abc123def456abc123def456";

describe("rewritePlaylist — multi-rung master", () => {
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-STREAM-INF:BANDWIDTH=5350000,RESOLUTION=1920x1080",
    "v0.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2996000,RESOLUTION=1280x720",
    "v1.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=1498000,RESOLUTION=854x480",
    "v2.m3u8",
    "",
  ].join("\n");

  it("rewrites every variant reference to the seg-proxy route, keyed", () => {
    const out = rewritePlaylist(master, KEY);
    const lines = out.split("\n");
    expect(lines).toContain(`/api/transcode/seg?key=${KEY}&f=v0.m3u8`);
    expect(lines).toContain(`/api/transcode/seg?key=${KEY}&f=v1.m3u8`);
    expect(lines).toContain(`/api/transcode/seg?key=${KEY}&f=v2.m3u8`);
  });

  it("preserves every #EXT-X-STREAM-INF line (RESOLUTION/BANDWIDTH intact for hls.js)", () => {
    const out = rewritePlaylist(master, KEY);
    expect(out).toContain("#EXT-X-STREAM-INF:BANDWIDTH=5350000,RESOLUTION=1920x1080");
    expect(out).toContain("#EXT-X-STREAM-INF:BANDWIDTH=2996000,RESOLUTION=1280x720");
    expect(out).toContain("#EXT-X-STREAM-INF:BANDWIDTH=1498000,RESOLUTION=854x480");
  });

  it("preserves line count and blank/comment lines unchanged", () => {
    const out = rewritePlaylist(master, KEY);
    expect(out.split("\n").length).toBe(master.split("\n").length);
    expect(out.split("\n")[0]).toBe("#EXTM3U");
  });
});

describe("rewritePlaylist — media (variant) playlist with segments", () => {
  const variant = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:4",
    "#EXTINF:4.0,",
    "seg_0_00000.ts",
    "#EXTINF:4.0,",
    "seg_0_00001.ts",
  ].join("\n");

  it("rewrites segment references to the seg-proxy route", () => {
    const out = rewritePlaylist(variant, KEY);
    const lines = out.split("\n");
    expect(lines).toContain(`/api/transcode/seg?key=${KEY}&f=seg_0_00000.ts`);
    expect(lines).toContain(`/api/transcode/seg?key=${KEY}&f=seg_0_00001.ts`);
  });

  it("leaves #EXTINF and other tag lines untouched", () => {
    const out = rewritePlaylist(variant, KEY);
    expect(out).toContain("#EXTINF:4.0,");
    expect(out).toContain("#EXT-X-TARGETDURATION:4");
  });
});

describe("rewritePlaylist — flat single-rung master (segments referenced directly)", () => {
  const flat = ["#EXTM3U", "#EXTINF:4.0,", "seg_00000.ts", "#EXTINF:4.0,", "seg_00001.ts"].join(
    "\n"
  );

  it("rewrites the inline segments same as any media playlist", () => {
    const out = rewritePlaylist(flat, KEY);
    expect(out.split("\n")).toContain(`/api/transcode/seg?key=${KEY}&f=seg_00000.ts`);
    expect(out.split("\n")).toContain(`/api/transcode/seg?key=${KEY}&f=seg_00001.ts`);
  });
});

describe("rewritePlaylist — path safety", () => {
  it("strips any directory component before building the URL (never emits a raw path)", () => {
    const malicious = ["#EXTM3U", "#EXTINF:4.0,", "../../etc/passwd"].join("\n");
    const out = rewritePlaylist(malicious, KEY);
    expect(out).toContain(`/api/transcode/seg?key=${KEY}&f=passwd`);
    expect(out).not.toContain("..");
  });

  it("URL-encodes the basename", () => {
    const withSpace = ["#EXTM3U", "#EXTINF:4.0,", "seg with space.ts"].join("\n");
    const out = rewritePlaylist(withSpace, KEY);
    expect(out).toContain(encodeURIComponent("seg with space.ts"));
  });
});

describe("isMasterPlaylist", () => {
  it("true for a master referencing .m3u8 variant playlists", () => {
    expect(
      isMasterPlaylist(
        ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1", "v0.m3u8"].join("\n")
      )
    ).toBe(true);
  });

  it("false for a media playlist referencing .ts segments", () => {
    expect(isMasterPlaylist(["#EXTM3U", "#EXTINF:4.0,", "seg_00000.ts"].join("\n"))).toBe(false);
  });

  it("false for an empty/comment-only playlist", () => {
    expect(isMasterPlaylist(["#EXTM3U", "#EXT-X-ENDLIST"].join("\n"))).toBe(false);
  });
});

/**
 * fMP4 output (remux path). The init segment lives in a COMMENT line, which the
 * original rewriter skipped wholesale — leaving `init.mp4` to resolve against
 * /api/transcode as /api/init.mp4. An fMP4 stream decodes nothing without its
 * init segment, so this was a total-failure bug, invisible on the TS ladder.
 */
describe("rewritePlaylist — fMP4 / EXT-X-MAP", () => {
  const key = "a".repeat(24);

  it("rewrites the EXT-X-MAP init segment URI through the seg proxy", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:6.000000,",
      "seg_00000.m4s",
    ].join("\n");
    const out = rewritePlaylist(playlist, key);
    expect(out).toContain(`#EXT-X-MAP:URI="/api/transcode/seg?key=${key}&f=init.mp4"`);
    expect(out).toContain(`/api/transcode/seg?key=${key}&f=seg_00000.m4s`);
  });

  it("keeps other EXT-X-MAP attributes intact", () => {
    const out = rewritePlaylist('#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"', key);
    expect(out).toBe(
      `#EXT-X-MAP:URI="/api/transcode/seg?key=${key}&f=init.mp4",BYTERANGE="720@0"`
    );
  });

  it("reduces an EXT-X-MAP URI to its basename, like every other rewritten line", () => {
    const out = rewritePlaylist('#EXT-X-MAP:URI="../../etc/init.mp4"', key);
    expect(out).toBe(`#EXT-X-MAP:URI="/api/transcode/seg?key=${key}&f=init.mp4"`);
  });

  it("leaves comment tags that carry no URI untouched", () => {
    const playlist = "#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS";
    expect(rewritePlaylist(playlist, key)).toBe(playlist);
  });
});
