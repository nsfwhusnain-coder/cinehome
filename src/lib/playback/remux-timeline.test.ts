import { describe, expect, test } from "bun:test";
import {
  isLogicalTimeSeekable,
  logicalDuration,
  normalizeRemuxStart,
  toLogicalTime,
  toMediaTime,
} from "./remux-timeline";

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: (index) => values[index]![0],
    end: (index) => values[index]![1],
  };
}

describe("remux logical timeline", () => {
  test("starts shortly before a resume target and clamps at title bounds", () => {
    expect(normalizeRemuxStart(3600, 7200)).toBe(3594);
    expect(normalizeRemuxStart(4, 7200)).toBe(0);
    expect(normalizeRemuxStart(9000, 7200)).toBe(7199);
  });

  test("translates between title time and suffix-playlist time", () => {
    expect(toMediaTime(3600, 3594)).toBe(6);
    expect(toLogicalTime(6, 3594)).toBe(3600);
  });

  test("keeps the full runtime visible while a suffix playlist is growing", () => {
    expect(logicalDuration(40, 3594, 7200, true)).toBe(7200);
    expect(logicalDuration(3606, 3594, 7200, false)).toBe(7200);
  });

  test("tests seekability in media-local coordinates", () => {
    const seekable = ranges([[0, 90]]);
    expect(isLogicalTimeSeekable(seekable, 3650, 3594)).toBe(true);
    expect(isLogicalTimeSeekable(seekable, 4000, 3594)).toBe(false);
    expect(isLogicalTimeSeekable(seekable, 3500, 3594)).toBe(false);
  });
});
