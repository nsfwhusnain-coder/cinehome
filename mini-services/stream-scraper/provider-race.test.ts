import { describe, expect, it } from "bun:test";
import { raceProviderArms } from "./provider-race";

const delay = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const rejectAfter = (ms: number, error: Error): Promise<never> =>
  new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));

describe("raceProviderArms", () => {
  it("returns a healthy provider without waiting for a dead arm", async () => {
    const started = Date.now();
    const result = await raceProviderArms(
      [
        { provider: "healthy", run: () => delay(10, ["stream"]) },
        { provider: "dead", run: () => delay(250, [] as string[]) },
      ],
      { firstHitGraceMs: 15, maxWaitMs: 500 }
    );

    expect(result.entries).toEqual(["stream"]);
    expect(Date.now() - started).toBeLessThan(150);
    expect(result.outcomes.map((outcome) => outcome.provider)).toEqual([
      "healthy",
    ]);
  });

  it("collects peers that settle during the quality grace", async () => {
    const result = await raceProviderArms(
      [
        { provider: "first", run: () => delay(5, ["a"]) },
        { provider: "peer", run: () => delay(15, ["b"]) },
      ],
      { firstHitGraceMs: 30, maxWaitMs: 100 }
    );

    expect(result.entries).toEqual(["a", "b"]);
    expect(result.outcomes).toHaveLength(2);
  });

  it("delivers useful late results to cache enrichment", async () => {
    const late: string[] = [];
    await raceProviderArms(
      [
        { provider: "first", run: () => delay(5, ["a"]) },
        { provider: "slow", run: () => delay(45, ["b"]) },
      ],
      {
        firstHitGraceMs: 10,
        maxWaitMs: 100,
        onLateEntries: (_provider, entries) => late.push(...entries),
      }
    );
    await delay(60, null);

    expect(late).toEqual(["b"]);
  });

  it("records one provider error without poisoning peer results", async () => {
    const result = await raceProviderArms(
      [
        {
          provider: "broken",
          run: () => rejectAfter(5, new Error("offline")),
        },
        { provider: "healthy", run: () => delay(10, ["stream"]) },
      ],
      { firstHitGraceMs: 5, maxWaitMs: 100 }
    );

    expect(result.entries).toEqual(["stream"]);
    expect(result.outcomes.find((outcome) => outcome.provider === "broken"))
      .toMatchObject({ status: "error", count: 0, error: "offline" });
  });

  it("honors the hard ceiling when every arm hangs", async () => {
    const started = Date.now();
    const result = await raceProviderArms(
      [{ provider: "hung", run: () => delay(500, [] as string[]) }],
      { firstHitGraceMs: 10, maxWaitMs: 20 }
    );

    expect(result.entries).toEqual([]);
    expect(Date.now() - started).toBeLessThan(150);
  });
});
