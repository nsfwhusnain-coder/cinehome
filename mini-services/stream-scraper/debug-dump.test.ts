/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  debugBufferSize,
  flushDebugDump,
  formatDebugDump,
  isDebugEnabled,
  recordDebugCapture,
  resetDebugBuffer,
  type DebugCapture,
} from "./debug-dump";

/**
 * DEBUG_SCRAPER=true dump — see .claude/handoffs/agent-l-embeds.md. Off by
 * default (isDebugEnabled gates every call site so it's zero-cost when unset).
 */
describe("isDebugEnabled", () => {
  const original = process.env.DEBUG_SCRAPER;
  afterEach(() => {
    if (original === undefined) delete process.env.DEBUG_SCRAPER;
    else process.env.DEBUG_SCRAPER = original;
  });

  it("is false when unset", () => {
    delete process.env.DEBUG_SCRAPER;
    expect(isDebugEnabled()).toBe(false);
  });

  it("is false for 0/false/off", () => {
    for (const v of ["0", "false", "off", ""]) {
      process.env.DEBUG_SCRAPER = v;
      expect(isDebugEnabled()).toBe(false);
    }
  });

  it("is true for 1/true/on/yes (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes"]) {
      process.env.DEBUG_SCRAPER = v;
      expect(isDebugEnabled()).toBe(true);
    }
  });
});

describe("recordDebugCapture", () => {
  const original = process.env.DEBUG_SCRAPER;
  beforeEach(() => resetDebugBuffer());
  afterEach(() => {
    resetDebugBuffer();
    if (original === undefined) delete process.env.DEBUG_SCRAPER;
    else process.env.DEBUG_SCRAPER = original;
  });

  it("is a no-op when disabled", () => {
    delete process.env.DEBUG_SCRAPER;
    recordDebugCapture({ url: "https://x/y.m3u8", status: 200, contentType: "application/vnd.apple.mpegurl", size: 1000, provider: "Test" });
    expect(debugBufferSize()).toBe(0);
  });

  it("buffers captures when enabled", () => {
    process.env.DEBUG_SCRAPER = "1";
    recordDebugCapture({ url: "https://x/y.m3u8", status: 200, contentType: "application/vnd.apple.mpegurl", size: 1000, provider: "Test" });
    expect(debugBufferSize()).toBe(1);
  });
});

describe("formatDebugDump", () => {
  it("sorts largest-first and unknown sizes last", () => {
    const captures: DebugCapture[] = [
      { url: "https://x/small.ts", status: 200, contentType: "video/mp2t", size: 100, provider: "A" },
      { url: "https://x/big.ts", status: 200, contentType: "video/mp2t", size: 9_000_000, provider: "A" },
      { url: "https://x/unknown.ts", status: 200, contentType: "video/mp2t", size: null, provider: "A" },
    ];
    const text = formatDebugDump(captures);
    const bigIdx = text.indexOf("big.ts");
    const smallIdx = text.indexOf("small.ts");
    const unknownIdx = text.indexOf("unknown.ts");
    expect(bigIdx).toBeGreaterThan(-1);
    expect(bigIdx).toBeLessThan(smallIdx);
    expect(smallIdx).toBeLessThan(unknownIdx);
  });

  it("includes url/status/content-type/provider for every capture", () => {
    const text = formatDebugDump([
      { url: "https://cdn.example/master.m3u8", status: 200, contentType: "application/vnd.apple.mpegurl", size: 4096, provider: "VidFast" },
    ]);
    expect(text).toContain("https://cdn.example/master.m3u8");
    expect(text).toContain("200");
    expect(text).toContain("application/vnd.apple.mpegurl");
    expect(text).toContain("[VidFast]");
  });

  it("handles an empty capture list", () => {
    const text = formatDebugDump([]);
    expect(text).toContain("0 intercepted response(s)");
  });
});

describe("flushDebugDump", () => {
  const original = process.env.DEBUG_SCRAPER;
  beforeEach(() => resetDebugBuffer());
  afterEach(() => {
    resetDebugBuffer();
    if (original === undefined) delete process.env.DEBUG_SCRAPER;
    else process.env.DEBUG_SCRAPER = original;
  });

  it("returns null and writes nothing when disabled", async () => {
    delete process.env.DEBUG_SCRAPER;
    recordDebugCapture({ url: "https://x/y.m3u8", status: 200, contentType: "", size: null, provider: "Test" });
    const path = await flushDebugDump();
    expect(path).toBeNull();
  });

  it("returns null when enabled but nothing was captured", async () => {
    process.env.DEBUG_SCRAPER = "1";
    const path = await flushDebugDump();
    expect(path).toBeNull();
  });

  it("writes a timestamped .log file and clears the buffer", async () => {
    process.env.DEBUG_SCRAPER = "1";
    recordDebugCapture({ url: "https://x/y.m3u8", status: 200, contentType: "application/vnd.apple.mpegurl", size: 2048, provider: "Test" });
    const path = await flushDebugDump();
    expect(path).not.toBeNull();
    expect(path).toMatch(/scrape-.*\.log$/);
    const file = Bun.file(path as string);
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(text).toContain("https://x/y.m3u8");
    expect(debugBufferSize()).toBe(0);
    await Bun.$`rm -f ${path}`.quiet().catch(() => {});
  });
});
