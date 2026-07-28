import { describe, expect, it } from "bun:test";
import { mediaContentTypeForProxy } from "./hls-proxy";

describe("mediaContentTypeForProxy", () => {
  it("makes extensionless proxy responses decodable for debrid MP4 downloads", () => {
    expect(
      mediaContentTypeForProxy(
        "https://cdn.example/Movie.2024.1080p.mp4?token=signed",
        "application/force-download"
      )
    ).toBe("video/mp4");
  });

  it("normalizes generic segment MIME types from unambiguous extensions", () => {
    expect(
      mediaContentTypeForProxy(
        "https://cdn.example/video/segment.ts",
        "application/octet-stream"
      )
    ).toBe("video/mp2t");
    expect(
      mediaContentTypeForProxy(
        "https://cdn.example/video/chunk.m4s",
        "binary/octet-stream"
      )
    ).toBe("video/iso.segment");
  });

  it("preserves a specific upstream type and never guesses from an opaque URL", () => {
    expect(
      mediaContentTypeForProxy(
        "https://cdn.example/download/opaque",
        "video/mp4"
      )
    ).toBe("video/mp4");
    expect(
      mediaContentTypeForProxy(
        "https://cdn.example/download/opaque",
        "application/force-download"
      )
    ).toBe("application/force-download");
  });
});
