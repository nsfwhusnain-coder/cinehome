/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isNeverAutoDefaultUrl, isPoisonStreamUrl } from "./poison-url";

describe("client isPoisonStreamUrl (mirror of scraper)", () => {
  it("flags abuse host and hostinger / php wrappers", () => {
    expect(
      isPoisonStreamUrl("https://cloudflare-terms-of-service-abuse.com/stream.mp4")
    ).toBe(true);
    expect(
      isPoisonStreamUrl("https://x.hostingersite.com/vid1.php?id=1")
    ).toBe(true);
    expect(isPoisonStreamUrl("https://cdn.example.com/stream.php?u=1")).toBe(true);
  });

  it("allows normal m3u8 / hakunaymatata / cinepro proxy", () => {
    expect(
      isPoisonStreamUrl("https://moon.ironwallnet.net/hls/movie/abc/index.m3u8")
    ).toBe(false);
    expect(
      isPoisonStreamUrl("https://sacdn.hakunaymatata.com/videos/abc123.mp4")
    ).toBe(false);
    expect(
      isPoisonStreamUrl("http://127.0.0.1:3001/v1/proxy?url=https%3A%2F%2Fx%2Fm.m3u8")
    ).toBe(false);
  });

  it("isNeverAutoDefaultUrl mirrors poison", () => {
    expect(isNeverAutoDefaultUrl("https://a.hostingersite.com/x.php?1")).toBe(true);
    expect(isNeverAutoDefaultUrl("https://moon.ironwallnet.net/a.m3u8")).toBe(false);
  });

  it("detects a poison upstream hidden inside the same-origin HLS proxy", () => {
    const upstream =
      "https://aqua-vulture-337623.hostingersite.com/video/fight-club.mp4";
    const encoded = Buffer.from(upstream, "utf8").toString("base64url");
    expect(isPoisonStreamUrl(`/api/hls/session-1?u=${encoded}`)).toBe(true);
  });
});
