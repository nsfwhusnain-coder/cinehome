/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { withoutAdultTitles } from "./tmdb-filters";

describe("withoutAdultTitles", () => {
  it("keeps titles that are not flagged adult, including Animation", () => {
    const rows = [
      { id: 1, title: "Spirited Away", adult: false, genre_ids: [16] },
      { id: 2, title: "Frozen", genre_ids: [16] },
      { id: 3, title: "Fight Club", adult: false },
    ];
    expect(withoutAdultTitles(rows, true)).toEqual(rows);
  });

  it("drops only adult === true when the household filter is on", () => {
    const rows = [
      { id: 1, title: "Normal", adult: false },
      { id: 2, title: "Missing flag" },
      { id: 3, title: "Adult", adult: true },
    ];
    expect(withoutAdultTitles(rows, true).map((row) => row.id)).toEqual([1, 2]);
  });

  it("passes the catalog through when the filter is off", () => {
    const rows = [{ id: 3, title: "Adult", adult: true }];
    expect(withoutAdultTitles(rows, false)).toEqual(rows);
  });
});
