/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  CINEPRO_FAST_TIMEOUT_MS,
  CINEPRO_FULL_TIMEOUT_MS,
  rewriteProxyUrl,
  dedupeCineproVixsrcAgainstNative,
  isNativeVixsrcEntry,
  isCineproVixsrcEntry,
  type CineproDedupeEntry,
} from "./cinepro";

describe("CinePro timeout constants", () => {
  it("exports fast/full budgets with fast shorter than full", () => {
    expect(CINEPRO_FAST_TIMEOUT_MS).toBe(8_000);
    expect(CINEPRO_FULL_TIMEOUT_MS).toBe(12_000);
    expect(CINEPRO_FAST_TIMEOUT_MS).toBeLessThan(CINEPRO_FULL_TIMEOUT_MS);
    // Fast path should not exceed client-ish 8s ceiling by much.
    expect(CINEPRO_FAST_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
    // Full is well under the old 28s hang.
    expect(CINEPRO_FULL_TIMEOUT_MS).toBeLessThan(28_000);
  });
});

describe("rewriteProxyUrl", () => {
  const base = "http://cinepro-core:3000";

  it("rewrites localhost:3000 /v1/proxy onto CINEPRO_URL", () => {
    const raw =
      "http://localhost:3000/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fvixsrc.to%2Fplaylist%22%7D";
    expect(rewriteProxyUrl(raw, base)).toBe(
      "http://cinepro-core:3000/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fvixsrc.to%2Fplaylist%22%7D"
    );
  });

  it("rewrites 127.0.0.1:3000 /v1/proxy", () => {
    const raw = "http://127.0.0.1:3000/v1/proxy?data=abc";
    expect(rewriteProxyUrl(raw, base)).toBe(
      "http://cinepro-core:3000/v1/proxy?data=abc"
    );
  });

  it("rewrites any host:3000 /v1/proxy (docker-ish)", () => {
    const raw = "http://0.0.0.0:3000/v1/proxy?data=xyz";
    expect(rewriteProxyUrl(raw, base)).toBe(
      "http://cinepro-core:3000/v1/proxy?data=xyz"
    );
  });

  it("rewrites relative /v1/ paths onto base", () => {
    expect(rewriteProxyUrl("/v1/proxy?data=1", base)).toBe(
      "http://cinepro-core:3000/v1/proxy?data=1"
    );
  });

  it("leaves already-reachable non-loopback proxy URLs alone", () => {
    const raw = "http://cinepro-core:3000/v1/proxy?data=keep";
    // host:3000 still rewrites path onto base (same result)
    expect(rewriteProxyUrl(raw, base)).toBe(raw);
  });

  it("leaves plain CDN URLs alone", () => {
    const cdn = "https://vixsrc.to/playlist/abc?token=1";
    expect(rewriteProxyUrl(cdn, base)).toBe(cdn);
  });
});

function entry(
  partial: Pick<CineproDedupeEntry, "provider" | "label"> &
    Partial<CineproDedupeEntry>
): CineproDedupeEntry {
  return {
    url: partial.url ?? `https://example.test/${partial.provider}`,
    label: partial.label,
    provider: partial.provider,
    verified: partial.verified,
  };
}

describe("isNativeVixsrcEntry / isCineproVixsrcEntry", () => {
  it("classifies native Luna vs CinePro/VixSrc", () => {
    expect(
      isNativeVixsrcEntry(entry({ provider: "Vixsrc", label: "Luna" }))
    ).toBe(true);
    expect(
      isCineproVixsrcEntry(entry({ provider: "CinePro/VixSrc", label: "Luna" }))
    ).toBe(true);
    expect(
      isNativeVixsrcEntry(entry({ provider: "CinePro/VixSrc", label: "Luna" }))
    ).toBe(false);
    expect(
      isCineproVixsrcEntry(entry({ provider: "Vixsrc", label: "Luna" }))
    ).toBe(false);
    expect(
      isCineproVixsrcEntry(entry({ provider: "CinePro/Icefy", label: "Aether 1080" }))
    ).toBe(false);
  });
});

describe("dedupeCineproVixsrcAgainstNative", () => {
  it("drops CinePro VixSrc when native Luna is present", () => {
    const out = dedupeCineproVixsrcAgainstNative([
      entry({
        provider: "Vixsrc",
        label: "Luna",
        url: "https://vixsrc.to/playlist/a",
      }),
      entry({
        provider: "CinePro/VixSrc",
        label: "Luna",
        url: "http://cinepro-core:3000/v1/proxy?data=vix",
      }),
      entry({
        provider: "CinePro/Icefy",
        label: "Aether 1080",
        url: "http://cinepro-core:3000/v1/proxy?data=ice",
      }),
    ]);
    expect(out.map((e) => e.provider)).toEqual(["Vixsrc", "CinePro/Icefy"]);
  });

  it("keeps CinePro VixSrc when no native Luna", () => {
    const only = [
      entry({
        provider: "CinePro/VixSrc",
        label: "Luna",
        url: "http://cinepro-core:3000/v1/proxy?data=vix",
      }),
      entry({
        provider: "CinePro/FshareTV",
        label: "Share 720p",
        url: "http://cinepro-core:3000/v1/proxy?data=fs",
      }),
    ];
    expect(dedupeCineproVixsrcAgainstNative(only)).toEqual(only);
  });

  it("prefers CinePro when native is soft-failed and CinePro is playable", () => {
    const out = dedupeCineproVixsrcAgainstNative([
      entry({
        provider: "Vixsrc",
        label: "Luna",
        url: "https://vixsrc.to/playlist/a",
        verified: false,
      }),
      entry({
        provider: "CinePro/VixSrc",
        label: "Luna",
        url: "http://cinepro-core:3000/v1/proxy?data=vix",
        verified: true,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("CinePro/VixSrc");
  });

  it("prefers native when both playable (verified undefined on fast path)", () => {
    const out = dedupeCineproVixsrcAgainstNative([
      entry({ provider: "Vixsrc", label: "Luna", url: "https://vixsrc.to/p" }),
      entry({
        provider: "CinePro/VixSrc",
        label: "Luna",
        url: "http://cinepro-core:3000/v1/proxy?d=1",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("Vixsrc");
  });
});
