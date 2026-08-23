/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { convertSrtToVtt, getLanguageDisplayName } from "./subtitles-service";

const sampleSrt = `1
00:00:06,000 --> 00:00:12,074
Watch Online Movies and Series for FREE
www.osdb.link/lm

2
00:00:25,780 --> 00:00:28,780
<b>We used to look up at the sky</b>

3
00:00:29,000 --> 00:00:32,000
and wonder at our place in the stars.
`;

describe("subtitles-service", () => {
  it("maps language codes to friendly display names", () => {
    expect(getLanguageDisplayName("eng")).toBe("English");
    expect(getLanguageDisplayName("spa")).toBe("Spanish");
    expect(getLanguageDisplayName("fre")).toBe("French");
    expect(getLanguageDisplayName("pob")).toBe("Portuguese (BR)");
    expect(getLanguageDisplayName("ara")).toBe("Arabic");
  });

  it("converts SRT to clean WebVTT and removes spam/watermark lines", () => {
    const vtt = convertSrtToVtt(sampleSrt);
    expect(vtt).toStartWith("WEBVTT");
    // Verify commas are converted to dots in timestamps
    expect(vtt).toContain("00:00:25.780 --> 00:00:28.780");
    expect(vtt).toContain("00:00:29.000 --> 00:00:32.000");
    expect(vtt).toContain("We used to look up at the sky");
    expect(vtt).toContain("and wonder at our place in the stars.");

    // Verify promotional ads were stripped
    expect(vtt).not.toContain("www.osdb.link");
    expect(vtt).not.toContain("Watch Online Movies");
  });
});
