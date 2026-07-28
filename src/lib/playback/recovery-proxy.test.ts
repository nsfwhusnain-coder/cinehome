import { describe, expect, it } from "bun:test";
import { decodeUpstream } from "@/lib/hls-session";
import type { PlaybackSource } from "./types";
import { proxyRecoveryDebridSources } from "./recovery-proxy";

const SOURCE: PlaybackSource = {
  id: "debrid-example-native-1080-1",
  url: "https://51.download.real-debrid.com/d/example/movie.mp4",
  provider: "Debrid",
  quality: "1080p",
  label: "1080p • Debrid",
  type: "mp4",
  origin: "debrid",
  compat: "native",
};

describe("proxyRecoveryDebridSources", () => {
  it("keeps the upstream intact while making each recovery generation browser-distinct", () => {
    const first = proxyRecoveryDebridSources("user-1", [SOURCE], 101)[0]!;
    const second = proxyRecoveryDebridSources("user-1", [SOURCE], 102)[0]!;

    expect(first.id).toBe(SOURCE.id);
    expect(first.url).not.toBe(SOURCE.url);
    expect(first.url).not.toBe(second.url);

    const firstUrl = new URL(first.url, "http://cinehome");
    expect(firstUrl.pathname).toMatch(/^\/api\/hls\/[a-f0-9]{32}$/);
    expect(firstUrl.searchParams.get("recovery")).toBe("101");
    expect(decodeUpstream(firstUrl.searchParams.get("u")!)).toBe(SOURCE.url);
  });

  it("does not mutate the source roster supplied by the debrid resolver", () => {
    const original = { ...SOURCE };
    proxyRecoveryDebridSources("user-1", [SOURCE], 101);
    expect(SOURCE).toEqual(original);
  });
});
