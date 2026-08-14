/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decryptVidrockCiphertext,
  detectVidrockStreamType,
  isVidrockEnglishSlot,
  looksLikeDirectMediaUrl,
  parseVidrockPlaylist,
  resolveVidrock,
  VIDROCK_KEY_HEX,
  VIDROCK_MAX_STREAMS,
} from "./vidrock";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function encryptPlain(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(VIDROCK_KEY_HEX, "hex"),
    iv
  );
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const packed = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return packed.toString("base64url");
}

describe("vidrock decrypt", () => {
  it("round-trips AES-GCM base64url ciphertext", () => {
    const url = "https://edge.example/master.m3u8";
    expect(decryptVidrockCiphertext(encryptPlain(url))).toBe(url);
  });
});

describe("vidrock helpers", () => {
  it("keeps English slots and drops Hindi", () => {
    expect(isVidrockEnglishSlot("Orion", { language: "English", flag: "us" })).toBe(
      true
    );
    expect(isVidrockEnglishSlot("Hindi", { language: "Hindi", flag: "in" })).toBe(
      false
    );
  });

  it("detects HLS vs MP4 and playlist vs media URLs", () => {
    expect(detectVidrockStreamType("https://cdn.example/master.m3u8", "hls")).toBe(
      "hls"
    );
    expect(detectVidrockStreamType("https://cdn.example/a.mp4")).toBe("mp4");
    expect(looksLikeDirectMediaUrl("https://cdn.example/master.m3u8")).toBe(true);
    expect(looksLikeDirectMediaUrl("https://streamrk.site/playlist/abc")).toBe(
      false
    );
  });

  it("parses a JSON MP4 ladder high-to-low", () => {
    const rungs = parseVidrockPlaylist([
      { resolution: 360, url: "https://cdn.example/360.mp4" },
      { resolution: 1080, url: "https://cdn.example/1080.mp4" },
      { resolution: 720, url: "https://cdn.example/720.mp4" },
    ]);
    expect(rungs.map((rung) => rung.height)).toEqual([1080, 720, 360]);
    expect(VIDROCK_MAX_STREAMS).toBe(4);
  });
});

describe("resolveVidrock", () => {
  it("decrypts English HLS and expands an Astra JSON ladder onto one source", async () => {
    const hls = "https://edge.bison-6d7.workers.dev/file2/abc/master.m3u8";
    const playlist = "https://streamrk.site/playlist/astra";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/api/tv/95479/1/1")) {
        return new Response(
          JSON.stringify({
            Orion: { url: encryptPlain(hls), type: "hls", language: "English" },
            Astra: {
              url: encryptPlain(playlist),
              type: "mp4",
              language: "English",
            },
            Hindi: {
              url: encryptPlain("https://skip.example/hi.m3u8"),
              type: "hls",
              language: "Hindi",
            },
          }),
          { status: 200 }
        );
      }
      if (href === playlist) {
        return new Response(
          JSON.stringify([
            { resolution: 720, url: "https://v1.streamrk.site/720.mp4" },
            { resolution: 1080, url: "https://v1.streamrk.site/1080.mp4" },
            { resolution: 480, url: "https://v1.streamrk.site/480.mp4" },
          ]),
          { status: 200 }
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const streams = await resolveVidrock(95479, "tv", 1, 1);
    expect(streams.length).toBe(2);
    const orion = streams.find((stream) => stream.url === hls);
    const astra = streams.find((stream) => stream.url.includes("1080.mp4"));
    expect(orion?.label).toBe("Rock");
    expect(orion?.type).toBe("hls");
    expect(astra?.qualityRungs?.map((rung) => rung.height)).toEqual([
      1080, 720, 480,
    ]);
    expect(streams.every((stream) => stream.provider === "Vidrock")).toBe(true);
  });

  it("returns empty on a title miss", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ Orion: { url: null, type: null } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(resolveVidrock(1, "movie")).resolves.toEqual([]);
  });

  it("throws on HTTP 500", async () => {
    const { ProviderOutageError } = await import("./provider-outage");
    globalThis.fetch = (async () =>
      new Response("broken", { status: 500 })) as typeof fetch;
    await expect(resolveVidrock(1, "movie")).rejects.toBeInstanceOf(
      ProviderOutageError
    );
  });
});
