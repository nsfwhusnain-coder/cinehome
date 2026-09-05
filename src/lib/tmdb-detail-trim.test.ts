/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  DETAIL_CAST_LIMIT,
  DETAIL_CREW_LIMIT,
  trimTmdbDetails,
} from "./tmdb-detail-trim";

function details(overrides: Record<string, unknown> = {}) {
  return {
    id: 402431,
    title: "Wicked",
    release_date: "2024-11-20",
    credits: {
      cast: Array.from({ length: 396 }, (_, i) => ({ id: i, name: `Actor ${i}` })),
      crew: [
        { job: "Director", name: "Jon M. Chu" },
        ...Array.from({ length: 226 }, (_, i) => ({ job: "Best Boy", name: `Crew ${i}` })),
      ],
    },
    "watch/providers": { results: { US: { link: "x" }, GB: { link: "y" } } },
    videos: { results: [{ key: "abc" }] },
    ...overrides,
  };
}

describe("trimTmdbDetails", () => {
  it("keeps everything the detail view actually renders", () => {
    const out = trimTmdbDetails(details());
    expect(out.title).toBe("Wicked");
    expect(out.release_date).toBe("2024-11-20");
    expect(out.videos).toEqual({ results: [{ key: "abc" }] });
    // The view slices 12; the cap must stay above that.
    expect(out.credits.cast.length).toBe(DETAIL_CAST_LIMIT);
    expect(DETAIL_CAST_LIMIT).toBeGreaterThanOrEqual(12);
    expect(out.credits.cast[0]).toEqual({ id: 0, name: "Actor 0" });
    // The Director lookup must still succeed.
    expect(out.credits.crew.find((c: { job: string }) => c.job === "Director")?.name).toBe(
      "Jon M. Chu"
    );
  });

  it("drops the branch nothing reads", () => {
    const out = trimTmdbDetails(details());
    expect("watch/providers" in out).toBe(false);
  });

  it("caps crew after filtering to displayed jobs", () => {
    const out = trimTmdbDetails(details());
    expect(out.credits.crew.length).toBeLessThanOrEqual(DETAIL_CREW_LIMIT);
    expect(out.credits.crew.every((c: { job: string }) => c.job !== "Best Boy")).toBe(true);
  });

  it("cuts the payload substantially", () => {
    const before = JSON.stringify(details()).length;
    const after = JSON.stringify(trimTmdbDetails(details())).length;
    expect(after).toBeLessThan(before * 0.35);
  });

  it("preserves shape when branches are absent or malformed", () => {
    expect(trimTmdbDetails({ id: 1 })).toEqual({ id: 1 });
    // A missing cast/crew must stay missing rather than become [].
    const partial = trimTmdbDetails({ id: 1, credits: { cast: [{ id: 9 }] } });
    expect(partial.credits.cast).toEqual([{ id: 9 }]);
    expect("crew" in partial.credits).toBe(false);
  });

  it("does not mutate the input", () => {
    const input = details();
    trimTmdbDetails(input);
    expect(input.credits.cast.length).toBe(396);
    expect("watch/providers" in input).toBe(true);
  });
});
