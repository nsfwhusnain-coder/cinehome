import { describe, expect, it } from "bun:test";
import { storedQualityForCache } from "./cache-policy";

describe("debrid cache policy identity", () => {
  it("versions Real-Debrid roster slots after a ranking-policy change", () => {
    expect(storedQualityForCache("realdebrid", "native-1080-1")).toBe(
      "rich-v2:native-1080-1"
    );
  });

  it("does not invalidate the independent TorBox cache", () => {
    expect(storedQualityForCache("torbox", "1080p")).toBe("1080p");
  });

  it("does not version AllDebrid rows with the RD policy prefix", () => {
    expect(storedQualityForCache("alldebrid", "1080p")).toBe("1080p");
  });
});
