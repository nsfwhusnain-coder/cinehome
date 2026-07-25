import { describe, expect, it } from "bun:test";
import { firstDashMediaUrl } from "./probe";

describe("firstDashMediaUrl", () => {
  it("expands standard representation and numbered media templates", () => {
    const mpd = `
      <MPD>
        <BaseURL>https://cdn.example/video/</BaseURL>
        <Period><AdaptationSet mimeType="video/mp4">
          <SegmentTemplate media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="7" />
          <Representation id="1080" bandwidth="5000000" width="1920" height="1080" />
        </AdaptationSet></Period>
      </MPD>`;

    expect(firstDashMediaUrl(mpd, "https://origin.example/master.mpd")).toBe(
      "https://cdn.example/video/chunk-1080-00007.m4s"
    );
  });

  it("expands timeline templates", () => {
    const mpd = `
      <MPD><Period><AdaptationSet contentType="video">
        <SegmentTemplate media="v/$Bandwidth$/$Time$.m4s">
          <SegmentTimeline><S t="9000" d="4500" /></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="v1" bandwidth="2400000" height="720" />
      </AdaptationSet></Period></MPD>`;

    expect(firstDashMediaUrl(mpd, "https://cdn.example/path/master.mpd")).toBe(
      "https://cdn.example/path/v/2400000/9000.m4s"
    );
  });

  it("accepts direct media BaseURL documents", () => {
    const mpd = `<MPD><Period><BaseURL>movie.mp4</BaseURL></Period></MPD>`;
    expect(firstDashMediaUrl(mpd, "https://cdn.example/a/master.mpd")).toBe(
      "https://cdn.example/a/movie.mp4"
    );
  });

  it("never falls back to treating an unresolved manifest as media", () => {
    const mpd = `<MPD><Period><Representation id="v1" height="1080" /></Period></MPD>`;
    expect(firstDashMediaUrl(mpd, "https://cdn.example/master.mpd")).toBeNull();
  });
});
