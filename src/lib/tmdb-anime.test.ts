/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  isTmdbAnimeTitle,
  keywordsFromTmdbAppend,
  TMDB_ANIMATION_GENRE_ID,
} from "./tmdb-anime";

describe("isTmdbAnimeTitle", () => {
  it("classifies Japanese animation as anime", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID, 18],
        originalLanguage: "ja",
        originCountry: ["JP"],
      })
    ).toBe(true);
  });

  it("does not treat Western animation as anime", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID, 12],
        originalLanguage: "en",
        originCountry: ["US"],
      })
    ).toBe(false);
  });

  it("does not classify non-animation Japanese live action", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [18, 80],
        originalLanguage: "ja",
        originCountry: "JP",
      })
    ).toBe(false);
  });

  it("accepts an anime keyword when Animation is present", () => {
    expect(
      isTmdbAnimeTitle({
        genres: [{ id: TMDB_ANIMATION_GENRE_ID, name: "Animation" }],
        originalLanguage: "en",
        originCountry: ["US"],
        keywords: ["anime", "based on manga"],
      })
    ).toBe(true);
  });

  it("reads production_countries JP the same as origin_country", () => {
    expect(
      isTmdbAnimeTitle({
        genreIds: [TMDB_ANIMATION_GENRE_ID],
        originalLanguage: "en",
        productionCountries: [{ iso_3166_1: "JP" }],
      })
    ).toBe(true);
  });
});

describe("keywordsFromTmdbAppend", () => {
  it("reads movie keywords[] and TV results[]", () => {
    expect(
      keywordsFromTmdbAppend({ keywords: [{ name: "anime" }] })
    ).toEqual(["anime"]);
    expect(
      keywordsFromTmdbAppend({ results: [{ name: "seinen" }] })
    ).toEqual(["seinen"]);
  });
});
