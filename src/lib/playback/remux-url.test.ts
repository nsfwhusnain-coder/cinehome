/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { buildRemuxUrl } from "./remux-url";
import type { PlaybackSource } from "./types";

const source: PlaybackSource = {
  id: "hades",
  url: "https://download.example/movie.mkv",
  provider: "Debrid",
  label: "4K",
  quality: "2160p",
  type: "mp4",
  remuxTicket: "opaque-ticket",
};

describe("buildRemuxUrl", () => {
  it("carries the remux ticket so transcode never re-scrapes", () => {
    const url = buildRemuxUrl({
      source,
      mediaType: "movie",
      tmdbId: 550,
      audio: { preference: "english", preferredLanguage: "en" },
    });
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("ticket")).toBe("opaque-ticket");
    expect(parsed.searchParams.get("sourceId")).toBe("hades");
    expect(parsed.searchParams.get("mode")).toBe("remux");
  });
});
