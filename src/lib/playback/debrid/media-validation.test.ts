/// <reference types="bun-types" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  clearMediaValidationCache,
  MIN_EPISODE_BYTES,
  MIN_MOVIE_BYTES,
  validateDebridMediaLink,
  validateNativeBrowserContainer,
} from "./media-validation";

describe("validateDebridMediaLink", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requests += 1;
        const { pathname } = new URL(req.url);
        if (pathname === "/dead.mp4") return new Response("gone", { status: 404 });

        if (
          pathname === "/iso-bmff.bin" ||
          pathname === "/mpeg-transport.bin" ||
          pathname === "/oversized-range.bin"
        ) {
          const bytes = new Uint8Array(
            pathname === "/oversized-range.bin" ? 5_000 : 32
          );
          if (pathname === "/iso-bmff.bin") {
            bytes.set([0x66, 0x74, 0x79, 0x70], 4);
          } else {
            // Measured Blu-ray/M2TS shape: four-byte timestamp prefix,
            // followed by the MPEG-TS sync byte.
            bytes[4] = 0x47;
          }
          return new Response(bytes, {
            status: 206,
            headers: {
              "Accept-Ranges": "bytes",
              "Content-Range": `bytes 0-31/${MIN_MOVIE_BYTES}`,
              "Content-Length": String(bytes.length),
            },
          });
        }

        const total =
          pathname === "/clip.mp4"
            ? 1_184_727
            : pathname === "/episode.mp4"
              ? MIN_EPISODE_BYTES
              : MIN_MOVIE_BYTES;
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes 0-0/${total}`,
            "Content-Length": "1",
          },
        });
      },
    });
  });

  afterAll(() => server.stop(true));

  beforeEach(() => {
    requests = 0;
    clearMediaValidationCache();
  });

  function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
  }

  it("rejects the measured 1.18 MB movie-clip failure mode", async () => {
    const result = await validateDebridMediaLink(url("/clip.mp4"), "movie");
    expect(result.acceptable).toBe(false);
    expect(result.reason).toBe("too_small");
    expect(result.totalBytes).toBe(1_184_727);
  });

  it("accepts conservatively-sized movies and episodes", async () => {
    expect((await validateDebridMediaLink(url("/movie.mp4"), "movie")).acceptable).toBe(true);
    expect((await validateDebridMediaLink(url("/episode.mp4"), "tv")).acceptable).toBe(true);
  });

  it("rejects conclusive HTTP failures", async () => {
    const result = await validateDebridMediaLink(url("/dead.mp4"), "movie");
    expect(result).toMatchObject({ acceptable: false, reason: "http_error", status: 404 });
  });

  it("single-flights concurrent validation and caches the result", async () => {
    const target = url("/single-flight.mp4");
    const [first, second] = await Promise.all([
      validateDebridMediaLink(target, "movie"),
      validateDebridMediaLink(target, "movie"),
    ]);
    const third = await validateDebridMediaLink(target, "movie");
    expect(first.acceptable).toBe(true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(requests).toBe(1);
  });

  it("proves ISO-BMFF for an unknown native candidate", async () => {
    const result = await validateNativeBrowserContainer(url("/iso-bmff.bin"));
    expect(result).toMatchObject({
      acceptable: true,
      reason: "iso_bmff",
      container: "mp4",
      status: 206,
    });
  });

  it("rejects the measured M2TS signature instead of surfacing it as native", async () => {
    const result = await validateNativeBrowserContainer(
      url("/mpeg-transport.bin")
    );
    expect(result).toMatchObject({
      acceptable: false,
      reason: "unsupported_signature",
      container: null,
      status: 206,
    });
  });

  it("rejects a range response outside the signature probe's hard cap", async () => {
    const result = await validateNativeBrowserContainer(
      url("/oversized-range.bin")
    );
    expect(result).toMatchObject({
      acceptable: false,
      reason: "unsupported_signature",
      container: null,
      status: 206,
    });
  });
});
