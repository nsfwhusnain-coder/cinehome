/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { mergeDistinctStreamEntries } from "./source-entry-merge";

interface Entry {
  url: string;
  score: number;
}

function proxyUrl(upstream: string, authorization: string): string {
  const data = encodeURIComponent(
    JSON.stringify({ url: upstream, headers: { authorization } })
  );
  return `http://cinepro-core:3000/v1/proxy?data=${data}`;
}

function prefer(existing: Entry | undefined, candidate: Entry): Entry {
  return !existing || candidate.score >= existing.score ? candidate : existing;
}

describe("source entry instance merge", () => {
  it("preserves same-labelled fixed/adaptive siblings with distinct URLs", () => {
    const hd = { url: "https://media.example/1080/master.m3u8", score: 10 };
    const ultra = { url: "https://media.example/2160/master.m3u8", score: 20 };

    expect(mergeDistinctStreamEntries([hd, ultra], prefer)).toEqual([hd, ultra]);
  });

  it("collapses auth rotation without imposing a global codec cap", () => {
    const first = {
      url: "https://media.example/h265/a.m3u8?token=old",
      score: 10,
    };
    const renewed = {
      url: "https://media.example/h265/a.m3u8?token=new",
      score: 20,
    };
    const second = {
      url: "https://media.example/h265/b.m3u8?token=other",
      score: 15,
    };

    expect(mergeDistinctStreamEntries([first, renewed, second], prefer)).toEqual([
      renewed,
      second,
    ]);
  });

  it("replaces a tied stale signed URL with the newly merged candidate", () => {
    const stale = {
      url: "https://media.example/master.m3u8?token=stale",
      score: 20,
    };
    const refreshed = {
      url: "https://media.example/master.m3u8?token=refreshed",
      score: 20,
    };

    expect(mergeDistinctStreamEntries([stale, refreshed], prefer)).toEqual([
      refreshed,
    ]);
  });

  it("collapses nested proxy auth rotation but preserves distinct rungs", () => {
    const first = {
      url: proxyUrl(
        "https://media.example/2160/master.m3u8?token=one",
        "Bearer one"
      ),
      score: 10,
    };
    const renewed = {
      url: proxyUrl(
        "https://media.example/2160/master.m3u8?token=two",
        "Bearer two"
      ),
      score: 20,
    };
    const hd = {
      url: proxyUrl(
        "https://media.example/1080/master.m3u8?token=three",
        "Bearer three"
      ),
      score: 15,
    };

    expect(mergeDistinctStreamEntries([first, renewed, hd], prefer)).toEqual([
      renewed,
      hd,
    ]);
  });
});
