/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { extractVidlinkQualityMap, qualityMapToStream } from "./vidlink-quality";

describe("VidLink quality map", () => {
  it("reads stream.qualities into one 1080-first ladder", () => {
    const payload = {
      sourceId: "mbVault",
      stream: {
        type: "file",
        qualities: {
          "360": { type: "mp4", url: "https://cdn.example/360.mp4" },
          "1080": { type: "mp4", url: "https://cdn.example/1080.mp4" },
          "480": { type: "mp4", url: "https://cdn.example/480.mp4" },
        },
      },
    };
    const map = extractVidlinkQualityMap(payload);
    expect(map).not.toBeNull();
    const stream = qualityMapToStream(map!);
    expect(stream?.url).toBe("https://cdn.example/1080.mp4");
    expect(stream?.quality).toBe("1080p");
    expect(stream?.maxHeight).toBe(1080);
    expect(stream?.qualityRungs?.map((rung) => rung.height)).toEqual([
      1080, 480, 360,
    ]);
  });
});
