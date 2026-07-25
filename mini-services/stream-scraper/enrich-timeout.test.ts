/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { raceWithHardTimeout } from "./enrich-timeout";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("raceWithHardTimeout", () => {
  it("work resolves first: no HARD TIMEOUT callback; outcome work", async () => {
    let hardTimeouts = 0;
    const outcome = await raceWithHardTimeout(
      delay(10).then(() => "ok"),
      50,
      () => {
        hardTimeouts += 1;
      }
    );
    expect(outcome).toBe("work");
    expect(hardTimeouts).toBe(0);
    // Timer would have been 50ms — ensure late tick still does not fire.
    await delay(60);
    expect(hardTimeouts).toBe(0);
  });

  it("work never resolves: HARD TIMEOUT fires once; outcome timeout", async () => {
    let hardTimeouts = 0;
    const hung = new Promise<void>(() => {
      /* never settles */
    });
    const outcome = await raceWithHardTimeout(hung, 50, () => {
      hardTimeouts += 1;
    });
    expect(outcome).toBe("timeout");
    expect(hardTimeouts).toBe(1);
    await delay(80);
    expect(hardTimeouts).toBe(1);
  });

  it("work rejects first: no HARD TIMEOUT; rejection propagates", async () => {
    let hardTimeouts = 0;
    let caught: unknown;
    try {
      await raceWithHardTimeout(
        delay(10).then(() => {
          throw new Error("enrich-boom");
        }),
        50,
        () => {
          hardTimeouts += 1;
        }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("enrich-boom");
    expect(hardTimeouts).toBe(0);
    await delay(60);
    expect(hardTimeouts).toBe(0);
  });

  it("timeout wins first: late work may still complete without re-firing timeout", async () => {
    let hardTimeouts = 0;
    let workDone = false;
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = () => {
        workDone = true;
        resolve();
      };
    });

    const outcome = await raceWithHardTimeout(work, 30, () => {
      hardTimeouts += 1;
    });
    expect(outcome).toBe("timeout");
    expect(hardTimeouts).toBe(1);
    expect(workDone).toBe(false);

    resolveWork();
    await delay(20);
    expect(workDone).toBe(true);
    expect(hardTimeouts).toBe(1);
  });
});
