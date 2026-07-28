/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { appendNewSourceIdentities } from "./progressive-merge";

describe("progressive measured-roster merge", () => {
  it("does not let an unprobed duplicate replace measured failure evidence", () => {
    const measured: Array<{ id: string; probeOk?: boolean }> = [
      { id: "cinema", probeOk: false },
    ];
    const late: Array<{ id: string; probeOk?: boolean }> = [
      { id: "cinema" },
    ];
    expect(appendNewSourceIdentities(measured, late, (row) => row.id)).toEqual(
      measured
    );
  });

  it("appends each genuinely new late identity once", () => {
    const measured = [{ id: "luna" }];
    const late = [{ id: "solstice" }, { id: "solstice" }, { id: "debrid" }];
    expect(
      appendNewSourceIdentities(measured, late, (row) => row.id).map(
        (row) => row.id
      )
    ).toEqual(["luna", "solstice", "debrid"]);
  });
});
