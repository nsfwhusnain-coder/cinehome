/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { ProviderOutageError } from "./provider-outage";
import { resolveNotorrent } from "./notorrent";

const originalFetch = globalThis.fetch;

const lookup = async () => ({
  title: "Fight Club",
  year: "1999",
  imdbId: "tt0137523",
  type: "movie" as const,
  runtimeSeconds: 0,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveNotorrent outages vs title miss", () => {
  it("returns [] on 200 empty streams (title miss)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ streams: [] }), { status: 200 })) as typeof fetch;
    await expect(resolveNotorrent(550, "movie", undefined, undefined, lookup)).resolves.toEqual(
      []
    );
  });

  it("throws on HTTP 503", async () => {
    globalThis.fetch = (async () =>
      new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(
      resolveNotorrent(550, "movie", undefined, undefined, lookup)
    ).rejects.toBeInstanceOf(ProviderOutageError);
  });
});
