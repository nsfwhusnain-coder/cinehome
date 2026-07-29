/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { fetchProxied } from "./hls-proxy";
import type { HlsSession } from "./hls-session";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

function session(id: string, url: string): HlsSession {
  const host = new URL(url).hostname;
  return {
    id,
    userId: "user",
    referer: "https://player.example/watch",
    origin: "https://player.example",
    userAgent: "test",
    cookies: `session=${id}`,
    extraHeaders: {},
    rootUrl: url,
    allowedHosts: new Set([host]),
    expiresAt: Date.now() + 60_000,
  };
}

function mediaResponse(): Response {
  return new Response(
    new Uint8Array([0x47, 0x40, 0x00, 0x10]) as unknown as BodyInit,
    {
      status: 200,
      headers: { "Content-Type": "video/mp2t" },
    }
  );
}

describe("HLS proxy failure-cache hardening", () => {
  it("does not let one credential-bound session poison another", async () => {
    const upstream =
      `https://auth-origin-${originalDateNow()}.invalid/video/segment.ts`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls <= 3
        ? new Response("down", { status: 502 })
        : mediaResponse();
    }) as unknown as typeof fetch;

    const firstSession = session("credential-a", upstream);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await fetchProxied(firstSession, upstream, null)).status).toBe(502);
    }
    expect((await fetchProxied(firstSession, upstream, null)).status).toBe(502);
    expect(calls).toBe(3);

    const independent = await fetchProxied(
      session("credential-b", upstream),
      upstream,
      null
    );
    expect(independent.status).toBe(200);
    expect(calls).toBe(4);
    await independent.body?.cancel();
  });

  it("expires incomplete failure streaks before negative-cache admission", async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const upstream =
      `https://streak-expiry-${originalDateNow()}.invalid/video/segment.ts`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("down", { status: 502 });
    }) as unknown as typeof fetch;
    const scopedSession = session("streak-expiry", upstream);

    expect((await fetchProxied(scopedSession, upstream, null)).status).toBe(502);
    now += 30_001;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await fetchProxied(scopedSession, upstream, null)).status).toBe(502);
    }
    expect(calls).toBe(4);

    expect((await fetchProxied(scopedSession, upstream, null)).status).toBe(502);
    expect(calls).toBe(4);
  });

  it("bounds incomplete failure streaks and evicts the least-recent key", async () => {
    const origin = `https://streak-cap-${originalDateNow()}.invalid`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("down", { status: 502 });
    }) as unknown as typeof fetch;
    const scopedSession = session("streak-cap", `${origin}/root.ts`);

    for (let index = 0; index < 513; index++) {
      const upstream = `${origin}/segment-${index}.ts`;
      expect((await fetchProxied(scopedSession, upstream, null)).status).toBe(502);
    }

    const oldest = `${origin}/segment-0.ts`;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await fetchProxied(scopedSession, oldest, null)).status).toBe(502);
    }
    expect(calls).toBe(516);

    expect((await fetchProxied(scopedSession, oldest, null)).status).toBe(502);
    expect(calls).toBe(516);
  });

  it("cancels an intermediate redirect body before following the next hop", async () => {
    const upstream =
      `https://redirect-origin-${originalDateNow()}.invalid/video/segment.ts`;
    const destination =
      `https://redirect-cdn-${originalDateNow()}.invalid/video/segment.ts`;
    let calls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 302,
            headers: { Location: destination },
          }
        );
      }
      return mediaResponse();
    }) as unknown as typeof fetch;

    const response = await fetchProxied(
      session("redirect", upstream),
      upstream,
      null
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
    await response.body?.cancel();
  });

  it("honors a transient upstream 429 before exposing an error to playback", async () => {
    const upstream =
      `https://rate-limited-${originalDateNow()}.invalid/video/segment.ts`;
    let calls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 429,
            headers: { "Retry-After": "0" },
          }
        );
      }
      return mediaResponse();
    }) as unknown as typeof fetch;

    const response = await fetchProxied(
      session("rate-limit-recovery", upstream),
      upstream,
      null
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
    await response.body?.cancel();
  });

  it("bounds upstream 429 recovery to the cooldown ladder", async () => {
    const upstream =
      `https://rate-limit-bound-${originalDateNow()}.invalid/video/segment.ts`;
    let calls = 0;
    let cancellations = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancellations++;
          },
        }),
        {
          status: 429,
          headers: { "Retry-After": "0" },
        }
      );
    }) as unknown as typeof fetch;

    const response = await fetchProxied(
      session("rate-limit-bound", upstream),
      upstream,
      null
    );

    expect(response.status).toBe(429);
    expect(calls).toBe(4);
    expect(cancellations).toBe(4);
  });

  it("cancels a final upstream 4xx body before replacing the response", async () => {
    const upstream =
      `https://discard-4xx-${originalDateNow()}.invalid/video/segment.ts`;
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403 }
      )) as unknown as typeof fetch;

    const response = await fetchProxied(
      session("discard-final-4xx", upstream),
      upstream,
      null
    );

    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
  });
});
