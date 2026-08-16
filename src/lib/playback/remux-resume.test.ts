/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  REMUX_RESTART_COOLDOWN_MS,
  shouldRestartRemux,
} from "./remux-resume";

describe("shouldRestartRemux", () => {
  it("restarts a playing remux after a packer 404", () => {
    expect(
      shouldRestartRemux({
        remux: true,
        everPlayed: true,
        httpCode: 404,
        restartCount: 0,
        lastRestartAtMs: 0,
        nowMs: 60_000,
      })
    ).toBe(true);
  });

  it("does not restart before first frame or on a direct source", () => {
    expect(
      shouldRestartRemux({
        remux: true,
        everPlayed: false,
        httpCode: 404,
        restartCount: 0,
        lastRestartAtMs: 0,
        nowMs: 60_000,
      })
    ).toBe(false);
    expect(
      shouldRestartRemux({
        remux: false,
        everPlayed: true,
        httpCode: 404,
        restartCount: 0,
        lastRestartAtMs: 0,
        nowMs: 60_000,
      })
    ).toBe(false);
  });

  it("backs off after a recent restart and after the per-source budget", () => {
    expect(
      shouldRestartRemux({
        remux: true,
        everPlayed: true,
        httpCode: 503,
        restartCount: 1,
        lastRestartAtMs: 50_000,
        nowMs: 50_000 + REMUX_RESTART_COOLDOWN_MS - 1,
      })
    ).toBe(false);
    expect(
      shouldRestartRemux({
        remux: true,
        everPlayed: true,
        httpCode: 502,
        restartCount: 8,
        lastRestartAtMs: 0,
        nowMs: 120_000,
      })
    ).toBe(false);
  });
});
