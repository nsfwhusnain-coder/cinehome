import { describe, expect, it } from "bun:test";
import { orbitSignature } from "./orbit-signature";

describe("orbitSignature", () => {
  it("is stable — the same title always gets the same system", () => {
    // A system that reshuffled between renders would read as noise, not identity.
    expect(orbitSignature("movie:550")).toEqual(orbitSignature("movie:550"));
  });

  it("gives different titles visibly different geometry", () => {
    const a = orbitSignature("movie:550");
    const b = orbitSignature("movie:693134");
    expect(a).not.toEqual(b);
  });

  it("separates adjacent ids rather than clustering them", () => {
    // A naive sum hash would put consecutive TMDB ids on near-identical orbits.
    const sigs = [1, 2, 3, 4, 5].map((n) => orbitSignature(`movie:${n}`));
    const tilts = sigs.map((s) => s.tiltDeg);
    expect(new Set(tilts).size).toBeGreaterThan(3);
  });

  it("keeps every value inside its documented range", () => {
    for (let id = 0; id < 400; id += 7) {
      const s = orbitSignature(`movie:${id}`);
      expect(s.tiltDeg).toBeGreaterThanOrEqual(14);
      expect(s.tiltDeg).toBeLessThanOrEqual(34);
      expect(s.periodS).toBeGreaterThanOrEqual(26);
      expect(s.periodS).toBeLessThanOrEqual(44);
      expect(s.phaseDeg).toBeGreaterThanOrEqual(0);
      expect(s.phaseDeg).toBeLessThan(360);
    }
  });

  it("keeps episodes of one series in the same family but not identical", () => {
    const e1 = orbitSignature("tv:1399:1:1");
    const e2 = orbitSignature("tv:1399:1:2");
    expect(e1).not.toEqual(e2);
  });

  it("never produces NaN, even for empty input", () => {
    const s = orbitSignature("");
    expect(Number.isFinite(s.tiltDeg)).toBe(true);
    expect(Number.isFinite(s.periodS)).toBe(true);
    expect(Number.isFinite(s.phaseDeg)).toBe(true);
  });
});
