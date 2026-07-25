/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isRealDebridConfigured, unrestrictLink, resolveDebridDirectLink } from "./realdebrid";
import { resolveDebridSources, resolveFastDebridSources } from "./index";

/**
 * Hard constraint: with REAL_DEBRID_API_TOKEN unset, the whole tier must
 * NO-OP gracefully (zero debrid sources, never throw) so the app keeps
 * working exactly as today. No network calls should happen — the token
 * check is the very first thing resolveDebridSources does.
 */
describe("debrid tier — no token configured", () => {
  const original = process.env.REAL_DEBRID_API_TOKEN;

  beforeEach(() => {
    delete process.env.REAL_DEBRID_API_TOKEN;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.REAL_DEBRID_API_TOKEN;
    else process.env.REAL_DEBRID_API_TOKEN = original;
  });

  it("isRealDebridConfigured() is false", () => {
    expect(isRealDebridConfigured()).toBe(false);
  });

  it("resolveDebridSources returns [] without throwing (roster unchanged)", async () => {
    const sources = await resolveDebridSources({ tmdbId: 872585, mediaType: "movie" });
    expect(sources).toEqual([]);
  });

  it("resolveFastDebridSources (fast/prefetch path) also returns [] without throwing or any network call", async () => {
    const sources = await resolveFastDebridSources({ tmdbId: 872585, mediaType: "movie" });
    expect(sources).toEqual([]);
  });

  it("unrestrictLink returns null (no token to authenticate with)", async () => {
    const result = await unrestrictLink("https://real-debrid.com/d/whatever");
    expect(result).toBeNull();
  });

  it("resolveDebridDirectLink returns null (no token to authenticate with)", async () => {
    const result = await resolveDebridDirectLink("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result).toBeNull();
  });
});
