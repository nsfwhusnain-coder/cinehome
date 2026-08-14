/// <reference types="bun-types" />
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  classifyProbeKind,
  looksLikeHlsUrl,
  probeSourceBatch,
  type ProbeSession,
} from "./probe";

const SESSION: ProbeSession = {
  referer: "http://cinepro-core:3000/",
  origin: "http://cinepro-core:3000",
  userAgent: "CineHome probe test",
  cookies: "",
};

describe("looksLikeHlsUrl / classifyProbeKind", () => {
  it("does not treat CinePro /v1/proxy as HLS by URL alone", () => {
    expect(
      looksLikeHlsUrl("http://cinepro-core:3000/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Ffshare.example%2Ffile.mp4%22%7D")
    ).toBe(false);
    expect(looksLikeHlsUrl("https://cdn.example/master.m3u8")).toBe(true);
    expect(looksLikeHlsUrl("https://cdn.example/playlist.mpegurl")).toBe(true);
  });

  it("classifies mpegurl / #EXTM3U as HLS and video/mp4 as progressive", () => {
    expect(
      classifyProbeKind(
        "http://cinepro-core:3000/v1/proxy?data=abc",
        "application/vnd.apple.mpegurl",
        "#EXTM3U\n#EXTINF:4,\nseg.ts"
      )
    ).toBe("hls");
    expect(
      classifyProbeKind(
        "http://cinepro-core:3000/v1/proxy?data=abc",
        "video/mp4",
        "xxxxftypmp42mdat"
      )
    ).toBe("progressive");
  });
});

describe("CinePro proxy MP4 probes as progressive", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/proxy") {
          const body = new Uint8Array(512);
          body[4] = 0x66;
          body[5] = 0x74;
          body[6] = 0x79;
          body[7] = 0x70;
          return new Response(body, {
            headers: { "Content-Type": "video/mp4" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  it("marks a CinePro /v1/proxy MP4 probe.ok without requiring #EXTM3U", async () => {
    const url = `http://127.0.0.1:${server.port}/v1/proxy?data=fshare`;
    const results = await probeSourceBatch([{ url, session: SESSION }], {
      maxSources: 1,
    });
    const result = results.get(url);
    expect(result?.ok).toBe(true);
    expect(result?.error).toBeUndefined();
    expect(result?.error ?? "").not.toContain("playlist");
  });
});
