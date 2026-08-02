import { describe, expect, test } from "bun:test";
import type { PlaybackSource } from "./types";
import { buildCoordinatorShadowDecision } from "./coordinator-shadow";

function source(
  id: string,
  height: number,
  container: PlaybackSource["container"]
): PlaybackSource {
  return {
    id,
    url: `https://cdn.example/${id}`,
    provider: "test",
    label: id,
    quality: `${height}p`,
    type: "mp4",
    maxHeight: height,
    codec: "h264",
    container,
    origin: "debrid",
    compat: "native",
  };
}

describe("coordinator shadow", () => {
  test("projects readiness and reports fast-start decision without URLs", () => {
    const result = buildCoordinatorShadowDecision(
      [source("4k-remux", 2160, "mkv"), source("hd-direct", 1080, "mp4")],
      { playbackQuality: 2160, fourKStartup: "fast" }
    );
    expect(result.immediateSourceId).toBe("hd-direct");
    expect(result.deferredFourKSourceId).toBe("4k-remux");
    expect(result.eligibleReadyCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("cdn.example");
  });
});
