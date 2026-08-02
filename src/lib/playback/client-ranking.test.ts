import { describe, expect, test } from "bun:test";
import type { PlaybackSource } from "./types";
import { pickClientStartupSource } from "./client-ranking";

function source(
  id: string,
  maxHeight: number,
  container: PlaybackSource["container"]
): PlaybackSource {
  return {
    id,
    url: `https://example.test/${id}`,
    provider: "test",
    label: id,
    quality: `${maxHeight}p`,
    maxHeight,
    type: "mp4",
    codec: "h264",
    container,
    origin: "debrid",
    compat: "native",
  };
}

describe("client startup ranking", () => {
  const remux4k = source("remux-4k", 2160, "mkv");
  const direct1080 = source("direct-1080", 1080, "mp4");
  const direct4k = source("direct-4k", 2160, "mp4");

  test("fast mode starts direct HD while exposing cold 4K for prewarm", () => {
    const decision = pickClientStartupSource([remux4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-1080");
    expect(decision.deferredFourK?.id).toBe("remux-4k");
    expect(decision.reason).toBe("fast_start_direct_hd");
  });

  test("maximum mode waits for the ranked 4K remux", () => {
    const decision = pickClientStartupSource([remux4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "maximum",
    });
    expect(decision.immediate?.id).toBe("remux-4k");
    expect(decision.deferredFourK).toBeNull();
  });

  test("direct 4K is never delayed", () => {
    const decision = pickClientStartupSource([direct4k, direct1080], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("direct-4k");
    expect(decision.deferredFourK).toBeNull();
  });

  test("keeps 4K remux when no direct HD fallback exists", () => {
    const decision = pickClientStartupSource([remux4k], {
      preferredHeight: 2160,
      fourKStartup: "fast",
    });
    expect(decision.immediate?.id).toBe("remux-4k");
  });
});
