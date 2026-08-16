/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  catalogTokens,
  knownTitleAlias,
  looksLikeUnplayableStub,
  pickBetterCatalogTitle,
  rewriteSearchResults,
  scoreCatalogCandidate,
  titleOverlapRatio,
} from "./title-alias";

describe("Barbie Dream House stub", () => {
  it("maps the 5-minute TMDB movie onto Dreamhouse Adventures", () => {
    expect(knownTitleAlias("movie", 1291377)).toEqual({
      mediaType: "tv",
      tmdbId: 89092,
      season: 1,
      episode: 1,
    });
  });

  it("treats a 5-minute movie with no IMDb as a stub", () => {
    expect(looksLikeUnplayableStub({ imdb_id: null, runtime: 5 })).toBe(true);
    expect(looksLikeUnplayableStub({ imdb_id: "tt1517268", runtime: 5 })).toBe(
      false
    );
    expect(looksLikeUnplayableStub({ imdb_id: null, runtime: 114 })).toBe(false);
  });
});

describe("title overlap", () => {
  it("splits dreamhouse so the TV show matches the stub name", () => {
    expect(catalogTokens("Barbie Dream House")).toEqual([
      "barbie",
      "dream",
      "house",
    ]);
    expect(
      titleOverlapRatio(
        "Barbie Dream House",
        "Barbie: Dreamhouse Adventures"
      )
    ).toBe(1);
    expect(titleOverlapRatio("Barbie Dream House", "Barbie")).toBeCloseTo(
      1 / 3
    );
  });

  it("prefers the 2018 Dreamhouse show over the 2023 Barbie movie", () => {
    const query = "Barbie Dream House";
    const year = 2018;
    const show = scoreCatalogCandidate(query, year, {
      id: 89092,
      mediaType: "tv",
      title: "Barbie: Dreamhouse Adventures",
      year: 2018,
      popularity: 40,
    });
    const movie = scoreCatalogCandidate(query, year, {
      id: 346698,
      mediaType: "movie",
      title: "Barbie",
      year: 2023,
      popularity: 400,
    });
    expect(show).toBeGreaterThan(movie);
    expect(movie).toBe(0);
  });

  it("picks the TV show from a mixed search list", () => {
    const picked = pickBetterCatalogTitle(
      "Barbie Dream House",
      2018,
      [
        {
          id: 1291377,
          mediaType: "movie",
          title: "Barbie Dream House",
          year: 2018,
        },
        {
          id: 346698,
          mediaType: "movie",
          title: "Barbie",
          year: 2023,
          popularity: 400,
        },
        {
          id: 89092,
          mediaType: "tv",
          title: "Barbie: Dreamhouse Adventures",
          year: 2018,
          popularity: 40,
        },
      ],
      { mediaType: "movie", tmdbId: 1291377 }
    );
    expect(picked?.id).toBe(89092);
    expect(picked?.mediaType).toBe("tv");
  });
});

describe("search rewrite", () => {
  it("replaces the stub card and drops the duplicate TV row", () => {
    const rows = rewriteSearchResults([
      { id: 1291377, media_type: "movie", title: "Barbie Dream House" },
      { id: 89092, media_type: "tv", name: "Barbie: Dreamhouse Adventures" },
      { id: 346698, media_type: "movie", title: "Barbie" },
    ]);
    expect(rows.map((row) => `${row.media_type}:${row.id}`)).toEqual([
      "tv:89092",
      "movie:346698",
    ]);
  });
});
