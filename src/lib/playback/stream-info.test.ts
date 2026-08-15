/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  buildStreamInfoRows,
  formatBitrateMbps,
  formatDelivery,
  formatFrameRate,
  formatResolution,
  inferDynamicRange,
} from "./stream-info";
import type { PlaybackSource } from "./types";

function source(over: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "luna",
    url: "/api/hls/x",
    provider: "Vixsrc",
    quality: "auto",
    label: "Luna",
    type: "hls",
    maxHeight: 2160,
    ladder: [2160, 1080, 720],
    bitrateBps: 18_400_000,
    codec: "h264",
    ...over,
  };
}

describe("stream info formatters", () => {
  it("formats bitrates the way a TV OSD would", () => {
    expect(formatBitrateMbps(18_400_000)).toBe("18.4 Mbps");
    expect(formatBitrateMbps(2_250_000)).toBe("2.25 Mbps");
    expect(formatBitrateMbps(800_000)).toBe("800 kbps");
    expect(formatBitrateMbps(0)).toBeNull();
  });

  it("formats cinema-aspect resolution with a friendly tier", () => {
    expect(formatResolution(3840, 1600)).toBe("3840 × 1600 · 4K");
    expect(formatResolution(1920, 800)).toBe("1920 × 800 · 1080p");
  });

  it("formats frame rates without inventing them", () => {
    expect(formatFrameRate(23.976)).toBe("23.98 fps");
    expect(formatFrameRate(24)).toBe("24 fps");
    expect(formatFrameRate(0)).toBeNull();
  });

  it("does not claim HDR without evidence", () => {
    expect(inferDynamicRange(source(), [])).toBe("SDR");
    expect(
      inferDynamicRange(source({ label: "Remux HDR10" }), [])
    ).toBe("HDR");
  });

  it("labels adaptive HLS vs a single file", () => {
    expect(formatDelivery(source())).toBe("HLS adaptive");
    expect(formatDelivery(source({ type: "mp4", ladder: undefined }))).toBe("MP4");
  });
});

describe("buildStreamInfoRows", () => {
  it("never invents 4K from a source label when the picture is 1080", () => {
    const rows = buildStreamInfoRows({
      source: source({ maxHeight: 2160, quality: "2160p" }),
      serverName: "Quasar",
      playingWidth: 1920,
      playingHeight: 1080,
      playingBitrate: 4_100_000,
      playingFps: 24,
      levels: [],
      audioTracks: [],
      activeAudioId: 0,
      bufferAheadS: 12,
    });
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    expect(byLabel.Output).toBe("1920 × 1080 · 1080p");
    expect(byLabel["Listed as"]).toBe("4K");
    expect(byLabel.Bitrate).toBe("4.10 Mbps");
  });

  it("omits empty rows and prefers live picture over source metadata", () => {
    const rows = buildStreamInfoRows({
      source: source(),
      serverName: "Luna",
      playingWidth: 1920,
      playingHeight: 800,
      playingBitrate: 6_200_000,
      playingFps: 23.976,
      levels: [],
      audioTracks: [{ id: 0, name: "English", channels: "2.0" }],
      activeAudioId: 0,
      bufferAheadS: 34,
    });
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    expect(byLabel.Output).toBe("1920 × 800 · 1080p");
    expect(byLabel["Listed as"]).toBe("4K");
    expect(byLabel.Bitrate).toBe("6.20 Mbps");
    expect(byLabel.Video).toBe("H.264");
    expect(byLabel["Frame rate"]).toBe("23.98 fps");
    expect(byLabel.Audio).toBe("English · 2.0");
    expect(byLabel.Source).toBe("Luna");
    expect(byLabel.Buffer).toBe("34 s");
    expect(rows.some((row) => row.value === "")).toBe(false);
  });
});
