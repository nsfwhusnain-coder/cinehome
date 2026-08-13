/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  coalescedEnrichmentKey,
  EnrichmentCoalescer,
} from "./enrich-coalescer";
import { raceWithHardTimeout } from "./enrich-timeout";

describe("background enrichment coalescing", () => {
  it("maps fast and full cache passes to one quality-scoped job", () => {
    const fast = "movie:550:::q2160:fast";
    const full = "movie:550:::q2160:full";

    expect(coalescedEnrichmentKey(fast)).toBe(coalescedEnrichmentKey(full));
    expect(coalescedEnrichmentKey(fast)).toBe("movie:550:::q2160");
  });

  it("elects one leader and retains both simultaneous cache targets", () => {
    const coalescer = new EnrichmentCoalescer();
    const jobKey = "tv:94997:1:1:q2160";
    const fast = coalescer.join(jobKey, `${jobKey}:fast`);
    const full = coalescer.join(jobKey, `${jobKey}:full`);

    expect(fast.leader).toBe(true);
    expect(full.leader).toBe(false);
    expect(coalescer.activeCount).toBe(1);
    expect(fast.targets()).toEqual([
      `${jobKey}:fast`,
      `${jobKey}:full`,
    ]);
    expect(coalescer.hasTarget(`${jobKey}:full`)).toBe(true);
  });

  it("does not coalesce different quality inventories", () => {
    const coalescer = new EnrichmentCoalescer();
    const hd = coalescer.join("movie:550:::q1080", "hd:fast");
    const ultra = coalescer.join("movie:550:::q2160", "ultra:full");

    expect(hd.leader).toBe(true);
    expect(ultra.leader).toBe(true);
    expect(coalescer.activeCount).toBe(2);
  });

  it("finishes the shared job once and returns every joined target", () => {
    const coalescer = new EnrichmentCoalescer();
    const jobKey = "movie:550:::q2160";
    const leader = coalescer.join(jobKey, `${jobKey}:fast`);
    coalescer.join(jobKey, `${jobKey}:full`);

    expect(leader.finish()).toEqual([
      `${jobKey}:fast`,
      `${jobKey}:full`,
    ]);
    expect(coalescer.activeCount).toBe(0);
    expect(coalescer.hasTarget(`${jobKey}:fast`)).toBe(false);
  });

  it("retains one leader after timeout and publishes every late join on completion", () => {
    const coalescer = new EnrichmentCoalescer();
    const jobKey = "movie:550:::q2160";
    const leader = coalescer.join(jobKey, `${jobKey}:fast`);

    leader.markTimedOut();
    expect(coalescer.hasJob(jobKey)).toBe(true);
    expect(coalescer.hasTarget(`${jobKey}:fast`)).toBe(false);

    const late = coalescer.join(jobKey, `${jobKey}:full`);
    expect(late.leader).toBe(false);
    expect(coalescer.activeCount).toBe(1);
    expect(leader.finish()).toEqual([
      `${jobKey}:fast`,
      `${jobKey}:full`,
    ]);
    expect(coalescer.activeCount).toBe(0);
  });

  it("publishes a late success once after the real timeout race settles", async () => {
    const coalescer = new EnrichmentCoalescer();
    const jobKey = "movie:550:::q2160";
    const leader = coalescer.join(jobKey, `${jobKey}:fast`);
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const publications: (readonly string[])[] = [];
    const settledWork = work.then(() => {
      const targets = leader.finish();
      if (targets) publications.push(targets);
    });

    const outcome = await raceWithHardTimeout(settledWork, 10, () => {
      leader.markTimedOut();
    });
    expect(outcome).toBe("timeout");
    expect(coalescer.hasJob(jobKey)).toBe(true);

    expect(coalescer.join(jobKey, `${jobKey}:full`).leader).toBe(false);
    resolveWork();
    await settledWork;

    expect(publications).toEqual([
      [`${jobKey}:fast`, `${jobKey}:full`],
    ]);
    expect(leader.finish()).toBeNull();
    expect(coalescer.activeCount).toBe(0);
  });

  it("cannot finish twice or delete a newer generation", () => {
    const coalescer = new EnrichmentCoalescer();
    const jobKey = "movie:550:::q2160";
    const first = coalescer.join(jobKey, `${jobKey}:fast`);

    expect(first.finish()).toEqual([`${jobKey}:fast`]);
    const second = coalescer.join(jobKey, `${jobKey}:full`);

    expect(second.leader).toBe(true);
    expect(first.finish()).toBeNull();
    expect(coalescer.hasJob(jobKey)).toBe(true);
    expect(second.finish()).toEqual([`${jobKey}:full`]);
    expect(coalescer.activeCount).toBe(0);
  });
});
