/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { probeSourceBatch, type ProbeableEntry } from "./probe";

const SESSION = {
  referer: "https://example.com/",
  origin: "https://example.com",
  userAgent: "test-agent",
  cookies: "",
};

function entry(url: string): ProbeableEntry {
  return { url, session: SESSION };
}

describe("probe poison early reject", () => {
  it("never marks abuse host as ok=true (no network needed)", async () => {
    const url = "https://cloudflare-terms-of-service-abuse.com/stream.mp4";
    const map = await probeSourceBatch([entry(url)]);
    const r = map.get(url);
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(r!.error).toBe("poison_url");
    expect(r!.speedScore).toBe(0);
  });

  it("never marks hostinger php wrapper as ok=true", async () => {
    const url = "https://foo.hostingersite.com/vid1.php?id=99";
    const map = await probeSourceBatch([entry(url)]);
    const r = map.get(url);
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(r!.error).toBe("poison_url");
  });
});
