/// <reference types="bun-types" />
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  isKnownTruncatedSource,
  probeSourceBatch,
  type ProbeSession,
} from "./probe";

const SESSION: ProbeSession = {
  referer: "http://127.0.0.1/",
  origin: "http://127.0.0.1",
  userAgent: "CineHome duration test",
  cookies: "",
};

function mediaPlaylist(segmentCount: number, segmentPath: string): string {
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:6"];
  for (let index = 0; index < segmentCount; index += 1) {
    lines.push("#EXTINF:6.0,", `${segmentPath}?n=${index}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

describe("HLS duration plausibility probe", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/short.m3u8") {
          return new Response(mediaPlaylist(22, "/short.ts"), {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        if (path === "/clip15.m3u8") {
          return new Response(mediaPlaylist(150, "/clip15.ts"), {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        if (path === "/episode20.m3u8") {
          return new Response(mediaPlaylist(200, "/episode20.ts"), {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        if (path === "/feature.m3u8") {
          return new Response(mediaPlaylist(650, "/feature.ts"), {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        if (path.endsWith(".ts")) {
          const body = new Uint8Array(1_024);
          body[0] = 0x47;
          return new Response(body, { headers: { "Content-Type": "video/mp2t" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  it("rejects a 132-second playlist for a two-hour movie", async () => {
    const url = `http://127.0.0.1:${server.port}/short.m3u8`;
    const results = await probeSourceBatch(
      [{ url, session: SESSION }],
      { maxSources: 1, mediaType: "movie", expectedDurationS: 2 * 60 * 60 }
    );
    expect(results.get(url)).toMatchObject({
      ok: false,
      error: "implausibly_short_duration",
      durationS: 132,
    });
    expect(isKnownTruncatedSource(url)).toBe(true);
  });

  it("rejects a 15-minute clip for an 80-minute movie", async () => {
    const url = `http://127.0.0.1:${server.port}/clip15.m3u8`;
    const results = await probeSourceBatch(
      [{ url, session: SESSION }],
      { maxSources: 1, mediaType: "movie", expectedDurationS: 80 * 60 }
    );
    expect(results.get(url)).toMatchObject({
      ok: false,
      error: "implausibly_short_duration",
      durationS: 900,
    });
    expect(isKnownTruncatedSource(url)).toBe(true);
  });

  it("keeps a ~20 minute TV episode and a special-length playlist", async () => {
    const url = `http://127.0.0.1:${server.port}/episode20.m3u8`;
    const episode = await probeSourceBatch(
      [{ url, session: SESSION }],
      { maxSources: 1, mediaType: "tv", expectedDurationS: 22 * 60 }
    );
    expect(episode.get(url)).toMatchObject({ ok: true, durationS: 1_200 });
    expect(isKnownTruncatedSource(url)).toBe(false);

    const special = await probeSourceBatch(
      [{ url, session: SESSION }],
      { maxSources: 1, mediaType: "tv", expectedDurationS: 45 * 60 }
    );
    expect(special.get(url)).toMatchObject({ ok: true, durationS: 1_200 });
  });

  it("keeps a plausible alternate cut", async () => {
    const url = `http://127.0.0.1:${server.port}/feature.m3u8`;
    const results = await probeSourceBatch(
      [{ url, session: SESSION }],
      { maxSources: 1, mediaType: "movie", expectedDurationS: 2 * 60 * 60 }
    );
    expect(results.get(url)).toMatchObject({ ok: true, durationS: 3_900 });
  });
});
