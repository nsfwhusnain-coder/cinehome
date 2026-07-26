/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isNeverAutoDefaultUrl, isPoisonStreamUrl } from "./poison-url";

describe("isPoisonStreamUrl", () => {
  it("flags cloudflare-terms-of-service-abuse host", () => {
    expect(
      isPoisonStreamUrl("https://cloudflare-terms-of-service-abuse.com/stream.mp4")
    ).toBe(true);
    expect(
      isPoisonStreamUrl(
        "https://cdn.cloudflare-terms-of-service-abuse.com/a/b/stream.mp4?x=1"
      )
    ).toBe(true);
  });

  it("flags hostingersite.com", () => {
    expect(
      isPoisonStreamUrl("https://something.hostingersite.com/play/vid1.php?id=99")
    ).toBe(true);
    expect(isPoisonStreamUrl("https://foo.hostingersite.com/master.m3u8")).toBe(true);
  });

  it("flags php wrapper / vid1.php redirectors", () => {
    expect(isPoisonStreamUrl("https://cdn.example.com/vid1.php?url=abc")).toBe(true);
    expect(isPoisonStreamUrl("https://pulse.example/stream.php?id=1")).toBe(true);
    expect(isPoisonStreamUrl("https://x.test/path/Vid1.PHP?token=z")).toBe(true);
  });

  it("allows normal ironwallnet / ironbubble m3u8", () => {
    expect(
      isPoisonStreamUrl("https://moon.ironwallnet.net/hls/movie/abc/index.m3u8")
    ).toBe(false);
    expect(
      isPoisonStreamUrl("https://moon.ironbubble.site/playlist/master.m3u8")
    ).toBe(false);
  });

  it("allows cinepro proxy playlist URLs", () => {
    expect(
      isPoisonStreamUrl("http://127.0.0.1:3001/v1/proxy?url=https%3A%2F%2Fcdn.example%2Fm.m3u8")
    ).toBe(false);
    expect(
      isPoisonStreamUrl("https://cinepro.internal/v1/proxy/playlist.m3u8")
    ).toBe(false);
  });

  it("allows normal hakunaymatata mp4", () => {
    expect(
      isPoisonStreamUrl("https://sacdn.hakunaymatata.com/videos/abc123.mp4")
    ).toBe(false);
    expect(
      isPoisonStreamUrl("https://bcdn.hakunaymatata.com/stream/1080/file.mp4")
    ).toBe(false);
  });

  it("isNeverAutoDefaultUrl mirrors poison", () => {
    const poison = "https://cloudflare-terms-of-service-abuse.com/stream.mp4";
    const clean = "https://moon.ironwallnet.net/hls/index.m3u8";
    expect(isNeverAutoDefaultUrl(poison)).toBe(isPoisonStreamUrl(poison));
    expect(isNeverAutoDefaultUrl(clean)).toBe(isPoisonStreamUrl(clean));
    expect(isNeverAutoDefaultUrl(poison)).toBe(true);
    expect(isNeverAutoDefaultUrl(clean)).toBe(false);
  });

  it("detects a poison upstream hidden inside the same-origin HLS proxy", () => {
    const upstream =
      "https://aqua-vulture-337623.hostingersite.com/video/fight-club.mp4";
    const encoded = Buffer.from(upstream, "utf8").toString("base64url");
    expect(isPoisonStreamUrl(`/api/hls/session-1?u=${encoded}`)).toBe(true);
  });

  it("empty / invalid inputs are not poison", () => {
    expect(isPoisonStreamUrl("")).toBe(false);
    expect(isPoisonStreamUrl("   ")).toBe(false);
  });
});
