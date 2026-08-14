/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  cineproEvalUntilIso,
  isCineproEvalWindowOpen,
  isProviderEnabled,
} from "./circuit";

const ORIGINAL = {
  PROVIDER_CINEPRO: process.env.PROVIDER_CINEPRO,
  CINEPRO_EVAL_UNTIL: process.env.CINEPRO_EVAL_UNTIL,
  CINEPRO_URL: process.env.CINEPRO_URL,
};

afterEach(() => {
  if (ORIGINAL.PROVIDER_CINEPRO === undefined) delete process.env.PROVIDER_CINEPRO;
  else process.env.PROVIDER_CINEPRO = ORIGINAL.PROVIDER_CINEPRO;
  if (ORIGINAL.CINEPRO_EVAL_UNTIL === undefined) delete process.env.CINEPRO_EVAL_UNTIL;
  else process.env.CINEPRO_EVAL_UNTIL = ORIGINAL.CINEPRO_EVAL_UNTIL;
  if (ORIGINAL.CINEPRO_URL === undefined) delete process.env.CINEPRO_URL;
  else process.env.CINEPRO_URL = ORIGINAL.CINEPRO_URL;
});

describe("CinePro re-enable / 48h eval (Change 4)", () => {
  it("is disabled when no URL and no opt-in", () => {
    delete process.env.PROVIDER_CINEPRO;
    delete process.env.CINEPRO_EVAL_UNTIL;
    delete process.env.CINEPRO_URL;
    expect(isProviderEnabled("cinepro")).toBe(false);
  });

  it("enables when CINEPRO_URL is configured without a kill switch", () => {
    delete process.env.PROVIDER_CINEPRO;
    delete process.env.CINEPRO_EVAL_UNTIL;
    process.env.CINEPRO_URL = "http://cinepro-core:3000";
    expect(isProviderEnabled("cinepro")).toBe(true);
  });

  it("enables when PROVIDER_CINEPRO=1", () => {
    process.env.PROVIDER_CINEPRO = "1";
    delete process.env.CINEPRO_EVAL_UNTIL;
    expect(isProviderEnabled("cinepro")).toBe(true);
  });

  it("enables inside CINEPRO_EVAL_UNTIL window without permanent flag", () => {
    delete process.env.PROVIDER_CINEPRO;
    const until = Date.now() + 60_000;
    process.env.CINEPRO_EVAL_UNTIL = String(until);
    expect(isCineproEvalWindowOpen(Date.now())).toBe(true);
    expect(isProviderEnabled("cinepro")).toBe(true);
  });

  it("enables via CINEPRO_EVAL_UNTIL ISO-8601 without PROVIDER_CINEPRO", () => {
    delete process.env.PROVIDER_CINEPRO;
    const until = new Date(Date.now() + 60_000).toISOString();
    process.env.CINEPRO_EVAL_UNTIL = until;
    expect(isCineproEvalWindowOpen(Date.now())).toBe(true);
    expect(isProviderEnabled("cinepro")).toBe(true);
  });

  it("disables after CINEPRO_EVAL_UNTIL expires", () => {
    delete process.env.PROVIDER_CINEPRO;
    process.env.CINEPRO_EVAL_UNTIL = String(Date.now() - 1_000);
    expect(isCineproEvalWindowOpen(Date.now())).toBe(false);
    expect(isProviderEnabled("cinepro")).toBe(false);
  });

  it("PROVIDER_CINEPRO=0 kills even when eval window is open", () => {
    process.env.PROVIDER_CINEPRO = "0";
    process.env.CINEPRO_EVAL_UNTIL = String(Date.now() + 60_000);
    expect(isCineproEvalWindowOpen(Date.now())).toBe(true);
    expect(isProviderEnabled("cinepro")).toBe(false);
  });

  it("cineproEvalUntilIso is ~48h ahead", () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const iso = cineproEvalUntilIso(from);
    expect(Date.parse(iso) - from).toBe(48 * 60 * 60 * 1000);
  });
});
