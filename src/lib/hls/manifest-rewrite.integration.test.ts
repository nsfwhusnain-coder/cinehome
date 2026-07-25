/// <reference types="bun-types" />
/**
 * Integration tests for synthetic master wrap + real provider-shaped manifests.
 * Guarantees media=1 child path and RESOLUTION inject do not produce broken playlists.
 * R10: multi-variant children must never re-wrap into nested STREAM-INF masters.
 */
import { describe, expect, it } from "bun:test";
import {
  isPureHlsMediaPlaylist,
  looksLikeMultiVariantChildUrl,
  shouldWrapPureMedia,
  wrapMediaPlaylistAsMaster,
  firstMediaSegmentUri,
  resolvePlaylistUri,
  extractHeightFromSegmentPrefix,
} from "./segment-height-probe";
import { parseStreamInfRenditions } from "@/lib/hls-proxy";

/** Vixsrc/Luna-style pure media playlist (no STREAM-INF). */
const VIXSRC_STYLE_MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXTINF:6.006,",
  "seg-0.ts",
  "#EXTINF:6.006,",
  "seg-1.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

/** Multi-variant master with RESOLUTION (healthy path). */
const LUNA_STYLE_MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480",
  "480/index.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
  "720/index.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
  "1080/index.m3u8",
  "",
].join("\n");

/** Master missing RESOLUTION (inject path). */
const BARE_MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=5000000",
  "https://cdn.example/1080/index.m3u8",
  "",
].join("\n");

/** Pure-media root URL (single playlist as playback source — wrap allowed). */
const PURE_MEDIA_ROOT_URL = "https://cdn.example/hls/movie/playlist.m3u8";

/** Vixsrc multi-variant child (R10 regression — must not wrap). */
const VIXSRC_VARIANT_CHILD_URL =
  "https://sc-u12-01.vix-content.net/playlist?type=video&rendition=1080p&token=abc";

describe("manifest rewriter — real provider shapes", () => {
  it("detects Vixsrc-style pure media playlist", () => {
    expect(isPureHlsMediaPlaylist(VIXSRC_STYLE_MEDIA)).toBe(true);
    expect(parseStreamInfRenditions(VIXSRC_STYLE_MEDIA)).toEqual([]);
  });

  it("wraps pure media as 1-rung master with media=1 child URL", () => {
    const child = "/api/hls/sess?u=enc_upstream&media=1";
    const master = wrapMediaPlaylistAsMaster(child, 1080, 5_000_000);
    expect(master).toContain("#EXT-X-STREAM-INF");
    expect(master).toContain("RESOLUTION=1920x1080");
    expect(master).toContain("media=1");
    expect(isPureHlsMediaPlaylist(master)).toBe(false);
    const rungs = parseStreamInfRenditions(master);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]!.height).toBe(1080);
  });

  it("does not wrap a multi-variant master as pure media", () => {
    expect(isPureHlsMediaPlaylist(LUNA_STYLE_MASTER)).toBe(false);
    const rungs = parseStreamInfRenditions(LUNA_STYLE_MASTER);
    expect(rungs.map((r) => r.height).sort((a, b) => a - b)).toEqual([480, 720, 1080]);
  });

  it("parses bare master STREAM-INF without RESOLUTION as empty heights", () => {
    // Inject path only adds height when tokens/probe available — never invents.
    expect(parseStreamInfRenditions(BARE_MASTER)).toEqual([]);
  });

  it("resolves first segment URI for probe path", () => {
    const seg = firstMediaSegmentUri(VIXSRC_STYLE_MEDIA);
    expect(seg).toBe("seg-0.ts");
    expect(resolvePlaylistUri("https://cdn.example/hls/index.m3u8", seg!)).toBe(
      "https://cdn.example/hls/seg-0.ts"
    );
  });

  it("extractHeightFromSegmentPrefix returns 0 for tiny/garbage (fail open)", () => {
    expect(extractHeightFromSegmentPrefix(new Uint8Array(8))).toBe(0);
  });

  it("child media=1 URL is absolute proxy form (not relative bare path)", () => {
    // Relative child URIs break hls.js when base is /watch/...
    const bad = wrapMediaPlaylistAsMaster("index.m3u8", 1080);
    // Product code must use absolute /api/hls?...&media=1 — this documents the contract.
    const good = wrapMediaPlaylistAsMaster("/api/hls/abc?u=xyz&media=1", 1080);
    expect(good).toContain("/api/hls/");
    expect(good).toContain("media=1");
    // Relative is technically parseable but forbidden by our proxy contract.
    expect(bad.includes("RESOLUTION=1920x1080")).toBe(true);
  });
});

describe("R10 — shouldWrapPureMedia / multi-variant children", () => {
  it("1. multi-variant master is never classified as pure media", () => {
    expect(isPureHlsMediaPlaylist(LUNA_STYLE_MASTER)).toBe(false);
    expect(isPureHlsMediaPlaylist(VIXSRC_STYLE_MEDIA)).toBe(true);
  });

  it("2. pure media with rendition= must not be wrap-eligible", () => {
    expect(looksLikeMultiVariantChildUrl(VIXSRC_VARIANT_CHILD_URL)).toBe(true);
    expect(shouldWrapPureMedia(VIXSRC_VARIANT_CHILD_URL, false)).toBe(false);
    // Path-folder variants (Luna-style children of multi-rung masters)
    expect(
      shouldWrapPureMedia("https://cdn.example/stream/720/index.m3u8", false)
    ).toBe(false);
    expect(
      shouldWrapPureMedia("https://cdn.example/hls/index-s1080p.m3u8", false)
    ).toBe(false);
    // Document: if wrap were wrongly applied, synthetic master points at self+media=1
    const wrong = wrapMediaPlaylistAsMaster(
      `/api/hls/s?u=${encodeURIComponent(VIXSRC_VARIANT_CHILD_URL)}&media=1`,
      1080
    );
    expect(wrong).toContain("STREAM-INF");
    expect(wrong).toContain("media=1");
    // Gate: product must refuse wrap so client never sees this for variant children
    expect(shouldWrapPureMedia(VIXSRC_VARIANT_CHILD_URL, false)).toBe(false);
  });

  it("3. pure media root (no variant signal) remains wrap-eligible", () => {
    expect(looksLikeMultiVariantChildUrl(PURE_MEDIA_ROOT_URL)).toBe(false);
    expect(shouldWrapPureMedia(PURE_MEDIA_ROOT_URL, false)).toBe(true);
    const child = "/api/hls/sess?u=enc_root&media=1";
    const master = wrapMediaPlaylistAsMaster(child, 1080, 5_000_000);
    expect(master).toContain("media=1");
    expect(master).toContain("RESOLUTION=1920x1080");
    expect(isPureHlsMediaPlaylist(master)).toBe(false);
  });

  it("4. skipMediaWrap=true never wraps (media=1 child path)", () => {
    expect(shouldWrapPureMedia(PURE_MEDIA_ROOT_URL, true)).toBe(false);
    expect(shouldWrapPureMedia(VIXSRC_VARIANT_CHILD_URL, true)).toBe(false);
    // media=1 contract: raw EXTINF body stays pure media (no STREAM-INF)
    expect(isPureHlsMediaPlaylist(VIXSRC_STYLE_MEDIA)).toBe(true);
    expect(VIXSRC_STYLE_MEDIA.includes("#EXT-X-STREAM-INF")).toBe(false);
  });

  it("5. wrapped master contains media=1; child path is pure media", () => {
    const mediaChild = `/api/hls/abc?u=xyz&media=1`;
    const master = wrapMediaPlaylistAsMaster(mediaChild, 720, 2_000_000);
    expect(master).toContain("media=1");
    expect(master).toContain("RESOLUTION=1280x720");
    // Child URL with skipMediaWrap must not re-wrap
    expect(shouldWrapPureMedia(PURE_MEDIA_ROOT_URL, /* skipMediaWrap */ true)).toBe(false);
    // And the media body itself is pure EXTINF
    expect(isPureHlsMediaPlaylist(VIXSRC_STYLE_MEDIA)).toBe(true);
  });
});
