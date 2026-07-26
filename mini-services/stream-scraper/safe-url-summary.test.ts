import { describe, expect, it } from "bun:test";
import { safeStreamTarget } from "./safe-url-summary";

describe("safeStreamTarget", () => {
  it("keeps only host and path kind for a signed MP4 URL", () => {
    const token = "SECRET-SIGNED-CREDENTIAL";
    const summary = safeStreamTarget(
      `https://media.example.test/private/title.mp4?token=${token}&expires=999`
    );

    expect(summary).toEqual({ host: "media.example.test", pathKind: "mp4" });
    expect(JSON.stringify(summary)).not.toContain(token);
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("classifies HLS and DASH without retaining path data", () => {
    expect(safeStreamTarget("https://hls.example/master.m3u8?sig=x")).toEqual({
      host: "hls.example",
      pathKind: "hls",
    });
    expect(safeStreamTarget("https://dash.example/a/manifest.mpd")).toEqual({
      host: "dash.example",
      pathKind: "dash",
    });
  });

  it("fails closed for malformed or missing URLs", () => {
    expect(safeStreamTarget("not a url")).toEqual({
      host: null,
      pathKind: "unknown",
    });
    expect(safeStreamTarget(null)).toEqual({
      host: null,
      pathKind: "unknown",
    });
  });
});
