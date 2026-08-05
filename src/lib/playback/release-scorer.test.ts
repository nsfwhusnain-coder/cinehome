import { describe, expect, it } from "bun:test";
import {
  classifyProvenance,
  isCaptureRelease,
  RELEASE_QUALITY_MAX_SCORE,
  releaseQualityScore,
  type ReleaseQualityInput,
} from "./release-scorer";

/** Minimal input; individual tests override what they are about. */
function release(title: string, over: Partial<ReleaseQualityInput> = {}): ReleaseQualityInput {
  return { title, audioCodec: "unknown", multiAudio: false, hdr: false, ...over };
}

describe("classifyProvenance", () => {
  it("reads the common mastering tags", () => {
    expect(
      classifyProvenance("Dune Part Two 2024 2160p UHD BluRay REMUX HDR HEVC TrueHD 7 1 Atmos-FraMeSToR")
    ).toBe("remux");
    expect(classifyProvenance("Oppenheimer 2023 1080p AMZN WEB-DL DDP5 1 Atmos H 264-FLUX")).toBe("webdl");
    expect(classifyProvenance("The Batman 2022 1080p BluRay x264-SPARKS")).toBe("bluray");
    expect(classifyProvenance("Some Show S01E01 1080p WEBRip x265-ION265")).toBe("webrip");
    expect(classifyProvenance("Some Show S01E01 720p HDTV x264-GROUP")).toBe("hdtv");
    expect(classifyProvenance("Old Movie 1998 DVDRip XviD-GROUP")).toBe("dvd");
  });

  it("prefers REMUX over BluRay, since every REMUX is also a Blu-ray source", () => {
    expect(classifyProvenance("Movie 2160p UHD BluRay REMUX HEVC")).toBe("remux");
  });

  it("does not let the bare WEB fallback swallow a WEB-DL", () => {
    // WEBRIP_PATTERN ends in a bare \bweb\b, so ordering is what keeps these
    // apart. If WEB-DL were tested second, every WEB-DL would read as a WEBRip.
    expect(classifyProvenance("Title 2024 1080p WEB-DL H264")).toBe("webdl");
    expect(classifyProvenance("Title 2024 1080p WEB DL H264")).toBe("webdl");
    expect(classifyProvenance("Title 2024 1080p NF WEB-DL DDP5 1")).toBe("webdl");
  });

  it("classifies capture rips ahead of whatever tier they claim to be", () => {
    // These routinely impersonate a better tier in the same name.
    expect(classifyProvenance("New Movie 2026 1080p HDCAM x264")).toBe("capture");
    expect(classifyProvenance("New Movie 2026 HDTS 1080p")).toBe("capture");
    expect(classifyProvenance("New Movie 2026 CAMRip")).toBe("capture");
    expect(classifyProvenance("New Movie 2026 TELESYNC 720p")).toBe("capture");
    expect(classifyProvenance("New Movie 2026 Telecine")).toBe("capture");
  });

  it("returns unknown when a name carries no source tag", () => {
    expect(classifyProvenance("Movie 2024 2160p HEVC")).toBe("unknown");
    expect(classifyProvenance("")).toBe("unknown");
  });
});

describe("isCaptureRelease — false-positive guards", () => {
  it("does not fire on words that merely contain cam", () => {
    // The penalty is four figures, so a false positive here buries a
    // legitimate release entirely. Word boundaries are load-bearing.
    expect(isCaptureRelease("Cameron Diaz Movie 2019 1080p BluRay")).toBe(false);
    expect(isCaptureRelease("Camp Rock 2008 720p WEB-DL")).toBe(false);
    expect(isCaptureRelease("Steadicam Documentary 2020 1080p")).toBe(false);
    expect(isCaptureRelease("Camden Town 2015 1080p WEBRip")).toBe(false);
  });

  it("does not fire on a bare ts token", () => {
    // \bts\b is deliberately not in the pattern — it appears in scene tags and
    // titles far too often to be evidence of a telesync.
    expect(isCaptureRelease("Some Movie 2024 1080p WEB-DL TS Audio")).toBe(false);
  });

  it("still fires on the real tokens", () => {
    expect(isCaptureRelease("Movie 2026 HDCAM")).toBe(true);
    expect(isCaptureRelease("Movie 2026 CAM")).toBe(true);
  });
});

describe("releaseQualityScore", () => {
  it("ranks mastering tiers in the expected order", () => {
    const remux = releaseQualityScore(release("Movie 2160p BluRay REMUX"));
    const webdl = releaseQualityScore(release("Movie 2160p WEB-DL"));
    const webrip = releaseQualityScore(release("Movie 2160p WEBRip"));
    const hdtv = releaseQualityScore(release("Movie 1080p HDTV"));
    expect(remux).toBeGreaterThan(webdl);
    expect(webdl).toBeGreaterThan(webrip);
    expect(webrip).toBeGreaterThan(hdtv);
  });

  it("sinks a capture below every other release by an unbridgeable margin", () => {
    // Size fitness tops out at 400 and seeders at 100 in candidateRankScore, so
    // the penalty has to clear both together — a new cam has excellent seeders.
    const cam = releaseQualityScore(release("Movie 2026 1080p HDCAM", { audioCodec: "truehd", hdr: true }));
    const worstLegit = releaseQualityScore(release("Movie 1998 DVDRip"));
    expect(cam).toBeLessThan(worstLegit - 500);
  });

  it("ignores audio and HDR bonuses on a capture", () => {
    // A cam claiming Atmos and HDR is claiming, not delivering.
    const dressed = releaseQualityScore(
      release("Movie 2026 HDCAM", { audioCodec: "truehd", hdr: true, multiAudio: true })
    );
    const plain = releaseQualityScore(release("Movie 2026 HDCAM"));
    expect(dressed).toBe(plain);
  });

  it("rewards the better audio tier at equal provenance", () => {
    const base = release("Movie 2160p WEB-DL");
    const truehd = releaseQualityScore({ ...base, audioCodec: "truehd" });
    const eac3 = releaseQualityScore({ ...base, audioCodec: "eac3" });
    const aac = releaseQualityScore({ ...base, audioCodec: "aac" });
    expect(truehd).toBeGreaterThan(eac3);
    expect(eac3).toBeGreaterThan(aac);
  });

  it("adds HDR and dual-audio bonuses", () => {
    const base = release("Movie 2160p WEB-DL");
    expect(releaseQualityScore({ ...base, hdr: true })).toBeGreaterThan(releaseQualityScore(base));
    expect(releaseQualityScore({ ...base, multiAudio: true })).toBeGreaterThan(
      releaseQualityScore(base)
    );
  });

  it("treats an untagged release as neutral rather than bad", () => {
    // Most names carry no source tag; an absent label is not evidence of a bad
    // encode, so unknown must not rank below a labelled HDTV.
    const unknown = releaseQualityScore(release("Movie 2024 2160p HEVC"));
    const hdtv = releaseQualityScore(release("Movie 2024 1080p HDTV"));
    expect(unknown).toBeGreaterThan(hdtv);
  });

  it("stays within its declared bounds", () => {
    const best = releaseQualityScore(
      release("Movie 2160p BluRay REMUX HDR", { audioCodec: "truehd", hdr: true, multiAudio: true })
    );
    expect(best).toBe(RELEASE_QUALITY_MAX_SCORE);
    // Bounded well under size fitness (400) on purpose — provenance reorders
    // comparable releases, it does not overturn the startup-latency tuning.
    expect(best).toBeLessThan(400);
  });

  it("scores nothing on codec, which is deliverability and handled elsewhere", () => {
    // A naive "HEVC is better" rule here would promote exactly the releases
    // Chrome cannot decode, fighting source-quality.ts's decode probes.
    const hevc = releaseQualityScore(release("Movie 2160p WEB-DL HEVC x265"));
    const h264 = releaseQualityScore(release("Movie 2160p WEB-DL H 264"));
    expect(hevc).toBe(h264);
  });
});
