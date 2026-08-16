/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { pickDebridVideoFile, type DebridTorrentFile } from "./realdebrid";

function file(
  id: number,
  path: string,
  bytes = 1_000_000_000
): DebridTorrentFile {
  return { id, path, bytes, selected: 0 };
}

describe("pickDebridVideoFile", () => {
  const movieA = file(1, "/MovieA.mkv", 8_000_000_000);
  const movieB = file(2, "/MovieB.mkv", 12_000_000_000);

  it("uses fileIdx when it lands on an RD file id", () => {
    expect(
      pickDebridVideoFile([movieA, movieB], { fileIdx: 1, releaseTitle: "MovieA" })
        ?.path
    ).toBe("/MovieB.mkv");
  });

  it("matches the title when fileIdx misses a pack", () => {
    expect(
      pickDebridVideoFile([movieA, movieB], {
        fileIdx: 9,
        releaseTitle: "MovieA 2024 1080p WEB-DL",
      })?.path
    ).toBe("/MovieA.mkv");
  });

  it("returns null when a pack is ambiguous and the title matches nothing", () => {
    expect(
      pickDebridVideoFile([movieA, movieB], {
        fileIdx: 9,
        releaseTitle: "Some Other Title 2024 1080p",
      })
    ).toBeNull();
  });

  it("returns null rather than the largest file when two titles both match", () => {
    expect(
      pickDebridVideoFile(
        [
          file(1, "/Movie.2024.CutA.mkv", 8_000_000_000),
          file(2, "/Movie.2024.CutB.mkv", 12_000_000_000),
        ],
        { releaseTitle: "Movie 2024 1080p WEB-DL" }
      )
    ).toBeNull();
  });

  it("ignores fileIdx when it lands on a sample or tiny file", () => {
    const sample = file(1, "/Movie.sample.mkv", 2_000_000);
    expect(
      pickDebridVideoFile([sample, movieA], {
        fileIdx: 0,
        releaseTitle: "MovieA 2024 1080p",
      })?.path
    ).toBe("/MovieA.mkv");
  });

  it("returns the only video file in a single-video torrent", () => {
    expect(
      pickDebridVideoFile(
        [file(1, "/readme.txt", 120), movieA],
        { releaseTitle: "Unrelated" }
      )?.path
    ).toBe("/MovieA.mkv");
  });
});
