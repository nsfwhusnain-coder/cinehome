/// <reference types="bun-types" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  clearMediaValidationCache,
  MIN_EPISODE_BYTES,
  MIN_MOVIE_BYTES,
  validateDebridMediaLink,
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
});
