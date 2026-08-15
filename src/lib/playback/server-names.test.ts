/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { baseServerToken, getServerDisplayName } from "./server-names";
import { GREEK_POOL, PREMIUM_GREEK_POOL } from "./server-theme";

describe("getServerDisplayName — Greek theme", () => {
  it("never includes quality/resolution in the name", () => {
    const names = [
      getServerDisplayName("vidking", "Solstice"),
      getServerDisplayName("cinepro", "Aether"),
      getServerDisplayName("Debrid", "4K • Debrid", "debrid-tt1-movie-0-0-native-2160"),
      getServerDisplayName("Debrid", "1080p • Debrid", "debrid-tt1-movie-0-0-native-1080-1"),
      getServerDisplayName("TorBox", "TorBox · 4K", "torbox-tt1-movie-0-0-2160p"),
    ];
    for (const name of names) {
      expect(name).not.toMatch(/\d{3,4}p/i);
      expect(name).not.toMatch(/4k/i);
    }
  });

  it("is a pure function of (provider, label, id) — identical inputs always produce the identical name", () => {
    const a = getServerDisplayName("vidlink", "Phoenix", "some-id-1");
    const b = getServerDisplayName("vidlink", "Phoenix", "some-id-1");
    expect(a).toBe(b);
    expect(a).toBe(getServerDisplayName("vidlink", "Phoenix", "some-id-1"));
  });

  it("is stable across repeated calls regardless of call order (no hidden index/counter state)", () => {
    const first = getServerDisplayName("vidking", "Solstice");
    // Interleave a bunch of unrelated lookups — must not perturb the result.
    getServerDisplayName("vidlink", "Phoenix");
    getServerDisplayName("cinepro", "Vienna");
    getServerDisplayName("Debrid", "4K • Debrid", "debrid-x-movie-0-0-native-2160");
    const second = getServerDisplayName("vidking", "Solstice");
    expect(first).toBe(second);
  });

  it("keeps the household names the owner actually uses", () => {
    expect(getServerDisplayName("vixsrc", "Luna")).toBe("Luna");
    expect(getServerDisplayName("videasy", "Quasar")).toBe("Quasar");
    expect(getServerDisplayName("vidlink", "Phoenix")).toBe("Phoenix");
    expect(
      getServerDisplayName("Debrid", "4K • Debrid", "debrid-tt1-movie-0-0-native-2160")
    ).toBe("Poseidon");
    expect(
      getServerDisplayName(
        "Debrid",
        "4K • Debrid · Safari",
        "debrid-tt1-movie-0-0-safari-2160"
      )
    ).toBe("Hades");
    expect(
      getServerDisplayName(
        "Debrid",
        "4K • Debrid · Safari",
        "debrid-tt1-movie-0-0-safari-2160-2"
      )
    ).toBe("Hades II");
    expect(
      getServerDisplayName(
        "Debrid",
        "1080p • Debrid",
        "debrid-tt1-movie-0-0-safari-1080"
      )
    ).toBe("Oceanus");
  });

  it("maps known embed provider strings to distinct Greek names", () => {
    const solstice = getServerDisplayName("vidking", "hls");
    const phoenix = getServerDisplayName("vidlink", "auto");
    const luna = getServerDisplayName("vixsrc", "");
    const rock = getServerDisplayName("vidrock", "Rock");
    expect(solstice).not.toBe(phoenix);
    expect(phoenix).not.toBe(luna);
    expect(solstice).not.toBe(luna);
    expect(rock).toBe("Nemesis");
  });

  it("passes through CinePro/LordFlix-style friendly labels via the theme table (never raw)", () => {
    const aether = getServerDisplayName("cinepro/icefy", "Aether");
    const vienna = getServerDisplayName("cinepro", "Vienna");
    expect(aether).not.toBe("Aether");
    expect(vienna).not.toBe("Vienna");
    expect(aether).not.toBe(vienna);
  });

  it("disambiguates numbered multi-CDN captures with a Roman numeral, not a raw digit", () => {
    const first = getServerDisplayName("vidlink", "Phoenix");
    const second = getServerDisplayName("vidlink", "Phoenix 2");
    const third = getServerDisplayName("vidlink", "Phoenix 3");
    expect(second).toBe(`${first} II`);
    expect(third).toBe(`${first} III`);
  });

  it("does not treat a quality-suffixed label (e.g. 'Share 1080p') as a numbered instance", () => {
    const name = getServerDisplayName("fshare", "Share 1080p");
    expect(name).not.toMatch(/II|III|\d/);
  });

  it("gives every CinemaOS locale/CDN row a distinct stable identity", () => {
    const labels = [
      "Cinema AR 1080",
      "Cinema FR 1080",
      "Cinema HI 1080",
      "Cinema PT 1080",
      "Cinema RU 1080",
      "Cinema XX 1080",
      "Cinema",
    ];
    const names = labels.map((label, index) =>
      getServerDisplayName(
        "CinemaOS",
        label,
        `cinemaos-${label.toLowerCase().replace(/\s+/g, "-")}-${index}`
      )
    );
    expect(new Set(names).size).toBe(labels.length);
    expect(names).not.toContain(getServerDisplayName("Vixsrc", "Luna"));
    // Quality enrichment must not rename the same logical locale/CDN.
    expect(getServerDisplayName("CinemaOS", "Cinema AR 720")).toBe(
      getServerDisplayName("CinemaOS", "Cinema AR 1080")
    );
  });

  it("routes Real-Debrid and TorBox sources through the disjoint premium pool", () => {
    const rdNative4k = getServerDisplayName("Debrid", "4K • Debrid", "debrid-tt1-movie-0-0-native-2160");
    const rdSafari4k = getServerDisplayName("Debrid", "4K • Debrid · Safari", "debrid-tt1-movie-0-0-safari-2160");
    const torbox4k = getServerDisplayName("TorBox", "TorBox · 4K", "torbox-tt1-movie-0-0-2160p");
    expect(PREMIUM_GREEK_POOL).toContain(rdNative4k);
    expect(PREMIUM_GREEK_POOL).toContain(rdSafari4k);
    expect(PREMIUM_GREEK_POOL).toContain(torbox4k);
    expect(rdNative4k).not.toBe(rdSafari4k);
    // Premium names never leak into the free-CDN pool and vice versa.
    for (const name of [rdNative4k, rdSafari4k, torbox4k]) {
      expect(GREEK_POOL).not.toContain(name);
    }
  });

  it("disambiguates RD's three identically-labeled native-1080p slots via their own id suffix — never sibling order", () => {
    const slot1 = getServerDisplayName("Debrid", "1080p • Debrid", "debrid-tt1-movie-0-0-native-1080-1");
    const slot2 = getServerDisplayName("Debrid", "1080p • Debrid", "debrid-tt1-movie-0-0-native-1080-2");
    const slot3 = getServerDisplayName("Debrid", "1080p • Debrid", "debrid-tt1-movie-0-0-native-1080-3");
    expect(new Set([slot1, slot2, slot3]).size).toBe(3);
    expect(slot2).toBe(`${slot1} II`);
    expect(slot3).toBe(`${slot1} III`);

    // Calling slot2 and slot3 in the OPPOSITE order (or without slot1/slot3
    // ever being resolved) must not change slot2's own name — it is a pure
    // function of its own id, not of what else is in the roster.
    const slot2Alone = getServerDisplayName("Debrid", "1080p • Debrid", "debrid-tt1-movie-0-0-native-1080-2");
    expect(slot2Alone).toBe(slot2);
  });

  it("never changes name across a different content item's id for the same logical slot", () => {
    // Same RD slot ("native-2160"), different title (different imdbId) —
    // the id changes entirely, but the slot's role is identical, so the
    // name must be identical too.
    const titleA = getServerDisplayName("Debrid", "4K • Debrid", "debrid-tt1000-movie-0-0-native-2160");
    const titleB = getServerDisplayName("Debrid", "4K • Debrid", "debrid-tt2000-tv-1-3-native-2160");
    expect(titleA).toBe(titleB);
  });

  it("falls back to a deterministic Greek name (never a raw string) for an unrecognized provider/label", () => {
    const pool: readonly string[] = GREEK_POOL;
    const name = getServerDisplayName("totally-new-mystery-provider", "Zephyrine");
    expect(pool).toContain(name.replace(/ (II|III|IV|V|VI|VII|VIII|IX|X)$/, ""));
    // And it's stable on repeat.
    expect(getServerDisplayName("totally-new-mystery-provider", "Zephyrine")).toBe(name);
  });

  it("premium and free-CDN Greek pools are fully disjoint", () => {
    const overlap = PREMIUM_GREEK_POOL.filter((n) => (GREEK_POOL as readonly string[]).includes(n));
    expect(overlap).toEqual([]);
  });
});

describe("baseServerToken — flag lookup helper", () => {
  it("returns the pre-theme token for embed sources (for config/servers.ts flag lookups)", () => {
    expect(baseServerToken("vidking", "hls")).toBe("solstice");
    expect(baseServerToken("cinepro", "Aether")).toBe("aether");
  });

  it("returns empty string for debrid/premium sources (no CDN-geography flag)", () => {
    expect(baseServerToken("Debrid", "4K • Debrid")).toBe("");
    expect(baseServerToken("TorBox", "TorBox · 1080p")).toBe("");
  });
});
