/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillShowCatalogs,
  catalogHasFourK,
  hydrateWarmRosters,
  knownGoodProviders,
  loadWarmRoster,
  persistWarmRoster,
  preferredProvidersForTitle,
  providersToSkip,
  readTitleCatalog,
  rememberTitleHits,
  rememberTitleMiss,
  rosterIdentity,
  safeMemoryName,
  showMemoryId,
  titleMemoryId,
  titleMemoryIdFromCacheKey,
} from "./source-memory";

const dirs: string[] = [];

function isolatedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinehome-memory-"));
  dirs.push(dir);
  process.env.SOURCE_MEMORY_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.SOURCE_MEMORY_DIR;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("source memory identity", () => {
  it("keys movies and episodes separately", () => {
    expect(titleMemoryId("movie", 550)).toBe("movie-550");
    expect(titleMemoryId("tv", 71912, 1, 1)).toBe("tv-71912-s1e1");
    expect(safeMemoryName("movie:550:::q2160:fast")).toBe("movie_550_q2160_fast");
    expect(titleMemoryIdFromCacheKey("movie:550:::q2160:fast")).toBe("movie-550");
    expect(titleMemoryIdFromCacheKey("tv:71912:1:1:q2160:full")).toBe(
      "tv-71912-s1e1"
    );
  });
});

describe("title catalog", () => {
  it("remembers which servers had 4K and skips recent empty providers", () => {
    isolatedDir();
    const id = titleMemoryId("movie", 550);
    rememberTitleHits(id, [
      { provider: "Videasy", label: "Quasar", maxHeight: 2160 },
      { provider: "Vixsrc", label: "Luna", maxHeight: 1080 },
    ]);
    rememberTitleMiss(id, "CinemaOS");
    const catalog = rememberTitleHits(id, [
      { provider: "Videasy", label: "Quasar", maxHeight: 2160 },
    ]);
    expect(catalogHasFourK(catalog)).toBe(true);
    expect(providersToSkip(catalog)).toEqual(["cinemaos"]);
    expect(providersToSkip(catalog)).not.toContain("videasy");
  });

  it("does not skip Videasy after a lowercase empty and a Quasar hit", () => {
    isolatedDir();
    const id = titleMemoryId("movie", 550);
    rememberTitleMiss(id, "videasy");
    const catalog = rememberTitleHits(id, [
      { provider: "Videasy", label: "Quasar", maxHeight: 2160 },
    ]);
    expect(providersToSkip(catalog)).toEqual([]);
    expect(knownGoodProviders(catalog)).toEqual(["videasy"]);
    rememberTitleMiss(id, "videasy");
    expect(providersToSkip(readTitleCatalog(id))).toEqual([]);
  });

  it("reuses show-level servers for a new episode", () => {
    isolatedDir();
    const show = showMemoryId(94997);
    const showCatalog = rememberTitleHits(show, [
      { provider: "Videasy", label: "Quasar", maxHeight: 2160 },
      { provider: "Vixsrc", label: "Luna", maxHeight: 1080 },
    ]);
    const episode = titleMemoryId("tv", 94997, 3, 9);
    rememberTitleMiss(episode, "videasy");
    rememberTitleMiss(episode, "cinemaos");
    expect(preferredProvidersForTitle(null, showCatalog)).toEqual(["videasy", "vixsrc"]);
    expect(providersToSkip(readTitleCatalog(episode), showCatalog)).toEqual(["cinemaos"]);
  });

  it("promotes episode catalogs into a show-level server list", () => {
    isolatedDir();
    rememberTitleHits(titleMemoryId("tv", 94997, 3, 8), [
      { provider: "Videasy", label: "Quasar", maxHeight: 2160 },
    ]);
    expect(backfillShowCatalogs()).toBe(1);
    expect(knownGoodProviders(readTitleCatalog(showMemoryId(94997)))).toEqual(["videasy"]);
  });
});

describe("warm roster disk", () => {
  it("returns a still-fresh roster and drops an expired one", () => {
    isolatedDir();
    persistWarmRoster(
      "movie:550:::q2160:fast",
      { streamUrl: "https://cdn.test/q.m3u8", sources: [{ label: "Quasar" }] },
      Date.now() + 60_000
    );
    persistWarmRoster("movie:13:::q1080:fast", { streamUrl: null, sources: [] }, Date.now() - 1);
    expect(loadWarmRoster("movie:550:::q2160:fast")?.result).toEqual({
      streamUrl: "https://cdn.test/q.m3u8",
      sources: [{ label: "Quasar" }],
    });
    expect(loadWarmRoster("movie:13:::q1080:fast")).toBeNull();
    expect(hydrateWarmRosters()).toHaveLength(1);
  });

  it("reuses one title file for fast/full and 1080/4K cache keys", () => {
    isolatedDir();
    persistWarmRoster(
      "movie:550:::q2160:fast",
      { streamUrl: "https://cdn.test/q.m3u8", sources: [{ label: "Quasar" }] },
      Date.now() + 60_000
    );
    expect(rosterIdentity("movie:550:::q1080:full")).toBe("movie-550");
    expect(loadWarmRoster("movie:550:::q1080:full")?.result).toEqual({
      streamUrl: "https://cdn.test/q.m3u8",
      sources: [{ label: "Quasar" }],
    });
  });
});
