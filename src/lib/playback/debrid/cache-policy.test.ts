import { describe, expect, it } from "bun:test";
import { storedQualityForCache } from "./cache-policy";
import { parseDebridPlaybackSourceId } from "./debrid-source-id";

describe("debrid cache policy identity", () => {
  it("versions Real-Debrid roster slots after a ranking-policy change", () => {
    expect(storedQualityForCache("realdebrid", "native-1080-1")).toBe(
      "rich-v4:native-1080-1"
    );
  });

  it("does not invalidate the independent TorBox cache", () => {
    expect(storedQualityForCache("torbox", "1080p")).toBe("1080p");
  });
});

describe("parseDebridPlaybackSourceId", () => {
  it("reads Real-Debrid roster slots without a live resolve", () => {
    expect(
      parseDebridPlaybackSourceId("debrid-tt0137523-movie-0-0-native-2160")
    ).toEqual({
      provider: "realdebrid",
      imdbId: "tt0137523",
      mediaType: "movie",
      season: 0,
      episode: 0,
      quality: "native-2160",
    });
  });

  it("ignores embed source ids", () => {
    expect(parseDebridPlaybackSourceId("cinemaos-cinema-hi")).toBeNull();
  });
});
