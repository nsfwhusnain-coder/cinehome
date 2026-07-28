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

  it("removes a source that failed this playback session from the user roster", () => {
    const a = source({ id: "a", provider: "vidking", label: "Solstice" });
    const b = source({ id: "b", provider: "vidlink", label: "Phoenix" });
    const slots = buildServerSlots([a, b], ["a"], false, undefined);
    expect(slots.map((s) => s.id)).toEqual(["b"]);
  });

  it("shows a curated flag when known and an honest globe when geography is unknown", () => {
    const free = source({ id: "free", provider: "vidking", label: "Solstice" });
    const premium = source({
      id: "debrid-tt1-movie-0-0-native-1080-1",
      provider: "Debrid",
      label: "1080p • Debrid",
      origin: "debrid",
      type: "mp4",
    });
    const slots = buildServerSlots([free, premium], [], false, undefined);
    expect(slots.find((slot) => slot.id === "free")?.flag).toBe("🇺🇸");
    expect(slots.find((slot) => slot.id === premium.id)?.flag).toBe("🌐");
  });

  it("collapses duplicate logical servers to their best healthy representation", () => {
    const ru1080 = source({
      id: "cinemaos-cinema-ru-1080",
      provider: "CinemaOS",
      label: "Cinema RU 1080",
      type: "mp4",
      maxHeight: 1080,
    });
    const ru720 = source({
      id: "cinemaos-cinema-ru-720",
      provider: "CinemaOS",
      label: "Cinema RU 720",
      type: "mp4",
      maxHeight: 720,
    });
    const slots = buildServerSlots([ru720, ru1080], [], false, undefined);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.id).toBe(ru1080.id);
    expect(slots[0]?.flag).toBe("🇷🇺");
  });

  it("EXPECTED_SERVERS identity table names are all Greek — no cosmic string leaks through", () => {
    const oldCosmicNames = new Set([
      "Aether", "Horizon", "Solstice", "Pulse", "Luna", "Phoenix", "CinePro",
      "Nova", "Orion", "Nest", "Joy", "Astra", "Blaze", "Comet", "Quasar",
    ]);
    for (const server of EXPECTED_SERVERS) {
      expect(oldCosmicNames.has(server.name)).toBe(false);
      const isEmbedGreek = (GREEK_POOL as readonly string[]).includes(server.name);
      const isPremiumGreek = (PREMIUM_GREEK_POOL as readonly string[]).includes(server.name);
      expect(isEmbedGreek || isPremiumGreek).toBe(true);
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
