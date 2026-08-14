/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  getCircuitSnapshot,
  resetCircuit,
  withCircuit,
} from "./circuit";

afterEach(() => {
  resetCircuit("cinemaos");
  resetCircuit("vixsrc");
});

describe("cinemaos empty is not an outage", () => {
  it("records success for an empty array when isSuccess is non-null", async () => {
    resetCircuit("cinemaos");
    const value = await withCircuit(
      "cinemaos",
      async () => [] as unknown[],
      { isSuccess: (r) => r != null }
    );
    expect(value).toEqual([]);
    const snap = getCircuitSnapshot("cinemaos");
    expect(snap.lastOk).toBe(true);
    expect(snap.lastError).toBeNull();
    expect(snap.state).toBe("closed");
  });

  it("still records empty_result when isSuccess requires length (old cinemaos bug)", async () => {
    resetCircuit("cinemaos");
    const value = await withCircuit(
      "cinemaos",
      async () => [] as unknown[],
      { isSuccess: (r) => Array.isArray(r) && r.length > 0 }
    );
    expect(value).toBeNull();
    expect(getCircuitSnapshot("cinemaos").lastError).toBe("empty_result");
    expect(getCircuitSnapshot("cinemaos").lastOk).toBe(false);
  });

  it("records a thrown timeout as failure", async () => {
    resetCircuit("vixsrc");
    const value = await withCircuit("vixsrc", async () => {
      throw new Error("vixsrc_timeout");
    });
    expect(value).toBeNull();
    expect(getCircuitSnapshot("vixsrc").lastError).toBe("vixsrc_timeout");
    expect(getCircuitSnapshot("vixsrc").lastOk).toBe(false);
  });
});
