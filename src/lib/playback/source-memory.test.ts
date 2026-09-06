/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  applySourceMemory,
  disqualifier,
  emptyRecord,
  foldFeedback,
  memoryRank,
  MEMORY_FRESH_DAYS,
  pickProvenSource,
  PROVEN_WATCH_MS,
  SHORT_PLAY_MS,
  sourceMemoryScope,
  trustLevel,
  type SourceMemoryRecord,
} from "./source-memory";
import type { PlaybackSource, PlayerFeedback } from "./types";

const NOW = 1_760_000_000_000;
const MS_PER_DAY = 86_400_000;

function record(patch: Partial<SourceMemoryRecord> = {}): SourceMemoryRecord {
  return { ...emptyRecord("quasar", "videasy", "Quasar"), ...patch };
}

function feedback(patch: Partial<PlayerFeedback> = {}): PlayerFeedback {
  return {
    event: "first_frame",
    sourceId: "quasar",
    provider: "videasy",
    occurredAt: NOW,
    ...patch,
  };
}

function source(patch: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "quasar",
    url: "https://cdn.example/stream.m3u8",
    provider: "videasy",
    quality: "auto",
    label: "Quasar",
    type: "hls",
    ...patch,
  } as PlaybackSource;
}

/** A source that played through and was watched — the shape of a good memory. */
function provenRecord(patch: Partial<SourceMemoryRecord> = {}): SourceMemoryRecord {
  return record({
    playCount: 2,
    watchedMs: PROVEN_WATCH_MS + 1,
    decodedHeight: 2160,
    lastGoodAt: NOW,
    ...patch,
  });
}

describe("sourceMemoryScope", () => {
  it("collapses movie season/episode to the sentinel", () => {
    expect(sourceMemoryScope("27205", "movie", 4, 9)).toEqual({
      tmdbId: "27205",
      mediaType: "movie",
      season: 0,
      episode: 0,
    });
  });

  it("keeps episodes distinct so one bad episode cannot taint a season", () => {
    const a = sourceMemoryScope("1399", "tv", 1, 1);
    const b = sourceMemoryScope("1399", "tv", 1, 2);
    expect(a).not.toEqual(b);
  });
});

describe("foldFeedback", () => {
  it("counts a first frame as an attempt, not yet a success", () => {
    const next = foldFeedback(record(), feedback({ timeToFirstFrameMs: 800 }));
    expect(next.playCount).toBe(1);
    expect(next.ttffMsAvg).toBe(800);
    // No watch time yet, so it must not be trusted on a first frame alone.
    expect(trustLevel(next, NOW)).toBe("probation");
  });

  it("keeps the highest decoded height ever observed", () => {
    let next = foldFeedback(record(), feedback({ decodedHeight: 1080 }));
    next = foldFeedback(
      next,
      feedback({ event: "decoded_resolution", decodedHeight: 2160 })
    );
    next = foldFeedback(
      next,
      feedback({ event: "decoded_resolution", decodedHeight: 720 })
    );
    expect(next.decodedHeight).toBe(2160);
  });

  it("rolls the first-frame average rather than replacing it", () => {
    let next = foldFeedback(record(), feedback({ timeToFirstFrameMs: 1000 }));
    next = foldFeedback(next, feedback({ timeToFirstFrameMs: 3000 }));
    expect(next.ttffMsAvg).toBe(2000);
  });

  it("resets the failure streak once something plays again", () => {
    const failing = record({ failStreak: 2, failCount: 2 });
    expect(foldFeedback(failing, feedback()).failStreak).toBe(0);
  });

  it("records a terminal failure with its reason", () => {
    const next = foldFeedback(
      record(),
      feedback({ event: "decode_error", reason: "codec_unsupported" })
    );
    expect(next.failCount).toBe(1);
    expect(next.lastReason).toBe("codec_unsupported");
  });

  it("treats a brief watch as a short play, not a success", () => {
    const next = foldFeedback(
      record({ playCount: 1 }),
      feedback({ event: "sustained_play" as PlayerFeedback["event"] }),
      SHORT_PLAY_MS - 1
    );
    expect(next.shortPlayCount).toBe(1);
    expect(next.lastGoodAt).toBeNull();
  });

  it("accumulates real watch time and stamps it good", () => {
    const next = foldFeedback(
      record({ playCount: 1 }),
      feedback({ event: "sustained_play" as PlayerFeedback["event"] }),
      PROVEN_WATCH_MS
    );
    expect(next.watchedMs).toBe(PROVEN_WATCH_MS);
    expect(next.lastGoodAt).toBe(NOW);
    expect(trustLevel(next, NOW)).toBe("proven");
  });
});

describe("disqualifier — the owner's 'make sure it is not X' list", () => {
  it("flags repeated short plays as the wrong video, not a network fault", () => {
    expect(disqualifier(record({ playCount: 3, shortPlayCount: 3 }))).toBe(
      "wrong_content"
    );
  });

  it("flags a source that renders no frame across repeated attempts as corrupt", () => {
    expect(disqualifier(record({ playCount: 0, failCount: 3 }))).toBe("corrupt");
  });

  it("flags an undecodable codec as incompatible", () => {
    const next = record({
      playCount: 1,
      failCount: 1,
      lastReason: "codec_unsupported",
    });
    expect(disqualifier(next)).toBe("incompatible");
  });

  it("flags a source that plays but stutters constantly", () => {
    expect(disqualifier(record({ playCount: 4, stallCount: 4 }))).toBe(
      "stall_prone"
    );
  });

  it("clears a healthy record", () => {
    expect(disqualifier(provenRecord())).toBeNull();
  });

  it("does not call a well-watched source wrong just for one short play", () => {
    const next = provenRecord({ shortPlayCount: 3 });
    expect(disqualifier(next)).toBeNull();
  });
});

describe("trustLevel", () => {
  it("is unknown with no record at all", () => {
    expect(trustLevel(undefined, NOW)).toBe("unknown");
  });

  it("promotes a watched source to proven", () => {
    expect(trustLevel(provenRecord(), NOW)).toBe("proven");
  });

  it("demotes stale evidence to probation instead of trusting it", () => {
    const stale = provenRecord({
      lastGoodAt: NOW - (MEMORY_FRESH_DAYS + 1) * MS_PER_DAY,
    });
    expect(trustLevel(stale, NOW)).toBe("probation");
  });

  it("distrusts a source that fails more often than it plays", () => {
    expect(trustLevel(record({ playCount: 1, failCount: 3 }), NOW)).toBe(
      "distrusted"
    );
  });
});

describe("applySourceMemory", () => {
  const keyOf = (s: PlaybackSource) => s.id;

  it("promotes a proven source above an unknown one at equal height", () => {
    const unknown = source({ id: "luna", maxHeight: 1080 });
    const proven = source({ id: "quasar", maxHeight: 1080 });
    const records = new Map([["quasar", provenRecord({ decodedHeight: 1080 })]]);
    const ordered = applySourceMemory([unknown, proven], records, keyOf, NOW);
    expect(ordered.map((s) => s.id)).toEqual(["quasar", "luna"]);
  });

  it("NEVER lets a remembered 1080p displace an available 4K", () => {
    const proven1080 = source({ id: "quasar", maxHeight: 1080 });
    const unknown4k = source({ id: "orion", maxHeight: 2160 });
    const records = new Map([["quasar", provenRecord({ decodedHeight: 1080 })]]);
    const ordered = applySourceMemory([proven1080, unknown4k], records, keyOf, NOW);
    expect(ordered[0]!.id).toBe("orion");
  });

  it("sinks a distrusted source below an unknown one", () => {
    const bad = source({ id: "aether", maxHeight: 1080 });
    const fresh = source({ id: "luna", maxHeight: 1080 });
    const records = new Map([
      ["aether", record({ playCount: 0, failCount: 4 })],
    ]);
    const ordered = applySourceMemory([bad, fresh], records, keyOf, NOW);
    expect(ordered.map((s) => s.id)).toEqual(["luna", "aether"]);
  });

  it("is stable — equal memory preserves the upstream ranking order", () => {
    const a = source({ id: "a", maxHeight: 1080 });
    const b = source({ id: "b", maxHeight: 1080 });
    const c = source({ id: "c", maxHeight: 1080 });
    const ordered = applySourceMemory([a, b, c], new Map(), keyOf, NOW);
    expect(ordered.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("treats unknown height as HD rather than assuming the worst", () => {
    const unknownHeight = source({ id: "pulse" });
    const subHd = source({ id: "old", maxHeight: 480 });
    const ordered = applySourceMemory([subHd, unknownHeight], new Map(), keyOf, NOW);
    expect(ordered[0]!.id).toBe("pulse");
  });
});

describe("pickProvenSource", () => {
  const keyOf = (s: PlaybackSource) => s.id;

  it("returns nothing when no source is proven, deferring to normal ranking", () => {
    const ordered = pickProvenSource([source()], new Map(), keyOf, NOW);
    expect(ordered).toBeNull();
  });

  it("takes the highest-resolution proven source", () => {
    const hd = source({ id: "quasar", maxHeight: 1080 });
    const uhd = source({ id: "orion", maxHeight: 2160 });
    const records = new Map([
      ["quasar", provenRecord({ decodedHeight: 1080 })],
      ["orion", provenRecord({ decodedHeight: 2160 })],
    ]);
    expect(pickProvenSource([hd, uhd], records, keyOf, NOW)?.id).toBe("orion");
  });

  it("ignores a distrusted source even when it is the only record", () => {
    const bad = source({ id: "aether", maxHeight: 2160 });
    const records = new Map([
      ["aether", record({ playCount: 0, failCount: 5 })],
    ]);
    expect(pickProvenSource([bad], records, keyOf, NOW)).toBeNull();
  });
});

describe("memoryRank", () => {
  it("orders proven above unknown above distrusted", () => {
    expect(memoryRank(provenRecord(), NOW)).toBeGreaterThan(
      memoryRank(undefined, NOW)
    );
    expect(memoryRank(undefined, NOW)).toBeGreaterThan(
      memoryRank(record({ playCount: 0, failCount: 4 }), NOW)
    );
  });
});
