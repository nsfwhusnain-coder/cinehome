import { describe, expect, it } from "bun:test";
import {
  applyHlsRecoveryPlan,
  seedNextAutoLevel,
  type HlsQualityEngine,
} from "./hls-engine-policy";

function engineRecorder(): {
  engine: HlsQualityEngine;
  writes: Array<[string, number | boolean]>;
} {
  const writes: Array<[string, number | boolean]> = [];
  const state = {
    capLevelToPlayerSize: true,
    autoLevelCapping: 4,
    loadLevel: 1,
    nextLoadLevel: 1,
    nextLevel: 1,
  };
  const engine = new Proxy(state, {
    set(target, property: keyof typeof state, value: number | boolean) {
      writes.push([property, value]);
      Reflect.set(target, property, value);
      return true;
    },
  });
  return { engine, writes };
}

describe("hls live quality actuator", () => {
  it("releases a fixed manual level before seeding Auto", () => {
    const { engine, writes } = engineRecorder();
    seedNextAutoLevel(engine, 3);

    expect(writes).toEqual([
      ["loadLevel", -1],
      ["nextLoadLevel", 3],
    ]);
  });

  it("uses a smooth manual nextLevel for a fixed recovery", () => {
    const { engine, writes } = engineRecorder();
    applyHlsRecoveryPlan(engine, { kind: "fixed", level: 2 });

    expect(writes).toContainEqual(["nextLevel", 2]);
    expect(writes.some(([property]) => property === "currentLevel")).toBe(false);
  });

  for (const kind of [
    "adaptive-downshift",
    "adaptive-climb",
    "absolute-floor",
  ] as const) {
    it(`keeps ${kind} under Auto control without a hard flush`, () => {
      const { engine, writes } = engineRecorder();
      applyHlsRecoveryPlan(engine, { kind, level: 2 });

      expect(writes).toContainEqual(["loadLevel", -1]);
      expect(writes).toContainEqual(["nextLoadLevel", 2]);
      expect(writes.some(([property]) => property === "nextLevel")).toBe(false);
      expect(writes.some(([property]) => property === "currentLevel")).toBe(false);
    });
  }
});
