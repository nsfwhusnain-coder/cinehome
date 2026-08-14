import { describe, expect, test } from "bun:test";
import { seasonDisplayName } from "./season-picker";

describe("seasonDisplayName", () => {
  test("labels season 0 as Specials", () => {
    expect(seasonDisplayName(0)).toBe("Specials");
    expect(seasonDisplayName(0, "Season 0")).toBe("Specials");
    expect(seasonDisplayName(0, "Specials")).toBe("Specials");
  });

  test("keeps TMDB specials names that are not Season 0", () => {
    expect(seasonDisplayName(0, "Holiday Specials")).toBe("Holiday Specials");
  });

  test("labels regular seasons", () => {
    expect(seasonDisplayName(1)).toBe("Season 1");
    expect(seasonDisplayName(2, "Season 2")).toBe("Season 2");
  });
});
