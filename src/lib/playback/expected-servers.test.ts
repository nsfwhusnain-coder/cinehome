/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { buildServerSlots, EXPECTED_SERVERS } from "./expected-servers";
import { getServerDisplayName } from "./server-names";
import { GREEK_POOL, PREMIUM_GREEK_POOL } from "./server-theme";
import type { PlaybackSource } from "./types";

function source(overrides: Partial<PlaybackSource>): PlaybackSource {
  return {
    id: "src-1",
    url: "https://example.com/stream.m3u8",
    provider: "cinepro",
    quality: "1080p",
    label: "Aether",
    type: "hls",
    maxHeight: 1080,
    ...overrides,
  };
}

describe("buildServerSlots — single source of truth for naming", () => {
  it("names a slot identically to getServerDisplayName for the same source (Cloud panel vs settings-dock Server section must never disagree)", () => {
    const s = source({ id: "aether-1", provider: "cinepro", label: "Aether", maxHeight: 1080 });
    const slots = buildServerSlots([s], [], false, undefined);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.name).toBe(getServerDisplayName(s.provider, s.label, s.id));
  });

  it("never bakes quality into the slot name — resolution lives in qualityLabel only", () => {
    const s = source({ id: "solstice-1", provider: "vidking", label: "Solstice", maxHeight: 2160 });
    const [slot] = buildServerSlots([s], [], false, undefined);
    expect(slot!.name).not.toMatch(/4k|2160|1080|720/i);
    expect(slot!.qualityLabel).toMatch(/4k/i);
  });

  it("marks Real-Debrid/TorBox sources as premium and names them from the disjoint premium pool", () => {
    const rd = source({
      id: "debrid-tt1-movie-0-0-native-2160",
      provider: "Debrid",
      label: "4K • Debrid",
      type: "mp4",
      maxHeight: 2160,
      origin: "debrid",
    });
    const [slot] = buildServerSlots([rd], [], false, undefined);
    expect(slot!.premium).toBe(true);
    expect(PREMIUM_GREEK_POOL).toContain(slot!.name);
  });

  it("free-CDN sources are never marked premium", () => {
    const s = source({ id: "phoenix-1", provider: "vidlink", label: "Phoenix" });
    const [slot] = buildServerSlots([s], [], false, undefined);
    expect(slot!.premium).toBeFalsy();
  });

  /**
   * Contract changed 2026-07-30 (owner request: "show all sources"). A failed
   * source is no longer hidden — hiding it left the panel showing 2 rows out of
   * a roster of 8+ and removed any way to retry something the prober disliked.
   * It is kept, marked, and sorted last instead.
   */
  it("keeps a session-failed source visible, marked and sorted last", () => {
    const a = source({
      id: "a",
      url: "https://solstice.example/master.m3u8",
      provider: "vidking",
      label: "Solstice",
    });
    const b = source({
      id: "b",
      url: "https://phoenix.example/master.m3u8",
      provider: "vidlink",
      label: "Phoenix",
    });
    const slots = buildServerSlots([a, b], ["a"], false, undefined);
    expect(slots.map((s) => s.id)).toEqual(["b", "a"]);
    expect(slots.find((s) => s.id === "a")?.status).toBe("failed");
  });

  it("shows a curated flag when known and an honest globe when geography is unknown", () => {
    const free = source({
      id: "free",
      url: "https://solstice.example/master.m3u8",
      provider: "vidking",
      label: "Solstice",
    });
    const premium = source({
      id: "debrid-tt1-movie-0-0-native-1080-1",
      url: "https://library.example/movie.mp4",
      provider: "Debrid",
      label: "1080p • Debrid",
      origin: "debrid",
      type: "mp4",
    });
    const slots = buildServerSlots([free, premium], [], false, undefined);
    expect(slots.find((slot) => slot.id === "free")?.flag).toBe("🇺🇸");
    expect(slots.find((slot) => slot.id === premium.id)?.flag).toBe("🌐");
  });

  /**
   * Contract changed 2026-07-30 (owner request: "show all sources"). Distinct
   * quality rungs of one logical server are SEPARATE selectable streams — each
   * is its own URL — and the in-player quality rail cannot switch between them,
   * because it only spans rungs inside a single manifest. Collapsing them by
   * display name alone was destroying most of the roster: CinePro/FshareTV ships
   * Share 1080p/720p/360p, which all resolve to one themed name, so six real
   * sources rendered as one row.
   */
  it("keeps distinct quality rungs of one server as separate rows", () => {
    const ru1080 = source({
      id: "cinemaos-cinema-ru-1080",
      url: "https://cinema.example/movie-1080.mp4",
      provider: "CinemaOS",
      label: "Cinema RU 1080",
      type: "mp4",
      maxHeight: 1080,
    });
    const ru720 = source({
      id: "cinemaos-cinema-ru-720",
      url: "https://cinema.example/movie-720.mp4",
      provider: "CinemaOS",
      label: "Cinema RU 720",
      type: "mp4",
      maxHeight: 720,
    });
    const slots = buildServerSlots([ru720, ru1080], [], false, undefined);
    expect(slots).toHaveLength(2);
    // Highest rung first, and each row carries its own honest badge.
    expect(slots[0]?.id).toBe(ru1080.id);
    expect(slots.map((s) => s.qualityLabel)).toEqual(["1080p", "720p"]);
    expect(slots[0]?.flag).toBe("🇷🇺");
  });

  it("still collapses an exact duplicate (same server AND same resolution)", () => {
    const a = source({ id: "dup-a", provider: "CinemaOS", label: "Cinema RU 1080", type: "mp4", maxHeight: 1080 });
    const b = source({ id: "dup-b", provider: "CinemaOS", label: "Cinema RU 1080", type: "mp4", maxHeight: 1080 });
    expect(buildServerSlots([a, b], [], false, undefined)).toHaveLength(1);
  });

  it("keeps distinct same-name 4K URLs as separate server rows", () => {
    const first = source({
      id: "licensed-4k-a",
      url: "https://a.media.example/master.m3u8",
      provider: "Licensed CDN",
      label: "HLS",
      maxHeight: 2160,
    });
    const second = source({
      id: "licensed-4k-b",
      url: "https://b.media.example/master.m3u8",
      provider: "Licensed CDN",
      label: "HLS",
      maxHeight: 2160,
    });

    expect(buildServerSlots([first, second], [], false, undefined)).toHaveLength(2);
  });

  it("shows richer 1080p above a leaner equal-resolution server", () => {
    const lean = source({
      id: "lean-1080",
      url: "https://lean.example/master.m3u8",
      bitrateBps: 2_500_000,
      ladder: [1080, 720, 480],
    });
    const rich = source({
      id: "rich-1080",
      url: "https://rich.example/video.m3u8",
      bitrateBps: 10_000_000,
      ladder: [1080],
    });

    expect(buildServerSlots([lean, rich], [], false, undefined)[0]?.id).toBe(
      "rich-1080"
    );
  });

  it("EXPECTED_SERVERS identity table names stay themed", () => {
    const retired = new Set([
      "Aether", "Horizon", "Solstice", "Pulse", "CinePro",
      "Nova", "Orion", "Nest", "Joy", "Astra", "Blaze", "Comet",
    ]);
    const household = new Set(["Luna", "Phoenix", "Quasar"]);
    for (const server of EXPECTED_SERVERS) {
      expect(retired.has(server.name)).toBe(false);
      const isEmbedGreek = (GREEK_POOL as readonly string[]).includes(server.name);
      const isPremiumGreek = (PREMIUM_GREEK_POOL as readonly string[]).includes(server.name);
      expect(isEmbedGreek || isPremiumGreek || household.has(server.name)).toBe(true);
    }
  });

  it("EXPECTED_SERVERS ids and matching hints are unchanged (matching/identity logic untouched)", () => {
    const ids = EXPECTED_SERVERS.map((s) => s.id);
    expect(ids).toEqual([
      "aether", "horizon", "solstice", "pulse", "luna", "phoenix", "cinepro",
      "nova", "orion", "nest", "joy", "astra", "blaze", "comet", "quasar",
    ]);
  });
});
