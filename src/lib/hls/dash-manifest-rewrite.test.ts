/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { HlsSession } from "@/lib/hls-session";
import {
  decodeUpstream,
  proxyUrlFor,
  resolveDashTemplateUpstream,
} from "@/lib/hls-session";
import { buildPlaybackProxyUrl, rewriteMpd } from "@/lib/hls-proxy";

const MANIFEST_URL = "https://manifest.example/catalog/title/stream.mpd";
const FIXTURE_URL = new URL("./fixtures/open-movie-2160-nested-baseurl.mpd", import.meta.url);
const fixtureMpd: string = await Bun.file(FIXTURE_URL).text();

function testSession(): HlsSession {
  return {
    id: "dash-session",
    userId: "viewer",
    referer: "https://watch.example/title/",
    origin: "https://watch.example",
    userAgent: "CineHome fixture test",
    cookies: "",
    extraHeaders: {},
    rootUrl: MANIFEST_URL,
    allowedHosts: new Set(["manifest.example"]),
    expiresAt: Date.now() + 60_000,
  };
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function attributeValues(mpd: string, name: string): string[] {
  const pattern = new RegExp(`\\b${name}="([^"]+)"`, "g");
  return [...mpd.matchAll(pattern)].map((match) => decodeXmlAttribute(match[1] || ""));
}

function baseUrlValues(mpd: string): string[] {
  return [...mpd.matchAll(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/g)].map((match) =>
    (match[1] || "").trim().replace(/&amp;/g, "&")
  );
}

function decodedProxyTarget(proxyUrl: string): string {
  const parsed = new URL(proxyUrl, "https://cinehome.example");
  return decodeUpstream(parsed.searchParams.get("u") || "");
}

function substituteDashValues(
  proxyUrl: string,
  representationId = "uhd-2160",
  bandwidth = "18000000"
): string {
  const substituted = proxyUrl
    .replaceAll("$RepresentationID$", representationId)
    .replaceAll("$Bandwidth$", bandwidth)
    .replaceAll("$Number%05d$", "00007")
    .replaceAll("$Number$", "7")
    .replaceAll("$Time$", "8000");
  return substituted.replace(
    /([?&](?:dv\d+|dbr)=)([^&]+)/g,
    (_match: string, prefix: string, value: string) =>
      `${prefix}${encodeURIComponent(decodeURIComponent(value))}`
  );
}

function resolvedTemplateTarget(session: HlsSession, proxyUrl: string): string | null {
  const substituted = new URL(substituteDashValues(proxyUrl), "https://cinehome.example");
  const template = decodeUpstream(substituted.searchParams.get("u") || "");
  return resolveDashTemplateUpstream(session, template, substituted.searchParams);
}

describe("DASH MPD proxy rewrite", () => {
  it("preserves dash.js tokens and resolves a 2160p nested BaseURL hierarchy", () => {
    const session = testSession();
    const rewritten = rewriteMpd(fixtureMpd, session, MANIFEST_URL);
    const initialization = attributeValues(rewritten, "initialization")[0] || "";
    const media = attributeValues(rewritten, "media")[0] || "";

    expect(rewritten).toContain('height="2160"');
    expect(initialization).toContain("$RepresentationID$");
    expect(initialization).toContain("$Bandwidth$");
    expect(media).toContain("$RepresentationID$");
    expect(media).toContain("$Number%05d$");
    expect(media).toContain("$Time$");
    expect(initialization.startsWith("/api/hls/dash-session?")).toBe(true);
    expect(media.startsWith("/api/hls/dash-session?")).toBe(true);

    expect(resolvedTemplateTarget(session, initialization)).toBe(
      "https://media.example/dash/open-movie/video/main/init-uhd-2160-18000000.mp4"
    );
    expect(resolvedTemplateTarget(session, media)).toBe(
      "https://media.example/dash/open-movie/video/main/segments/uhd-2160/chunk-00007-8000.m4s"
    );
  });

  it("routes one inherited SegmentTemplate through each Representation BaseURL", () => {
    const session = testSession();
    const rewritten = rewriteMpd(fixtureMpd, session, MANIFEST_URL);
    const media = attributeValues(rewritten, "media")[0] || "";
    const targetFor = (representationId: string, bandwidth: string): string | null => {
      const substituted = new URL(
        substituteDashValues(media, representationId, bandwidth),
        "https://cinehome.example"
      );
      const template = decodeUpstream(substituted.searchParams.get("u") || "");
      return resolveDashTemplateUpstream(session, template, substituted.searchParams);
    };

    expect(targetFor("hd-1080", "7000000")).toBe(
      "https://media.example/dash/open-movie/video/hd-main/segments/hd-1080/chunk-00007-8000.m4s"
    );
    expect(targetFor("uhd-2160", "18000000")).toBe(
      "https://media.example/dash/open-movie/video/main/segments/uhd-2160/chunk-00007-8000.m4s"
    );

    const tampered = new URL(
      substituteDashValues(media, "hd-1080", "7000000"),
      "https://cinehome.example"
    );
    tampered.searchParams.set("dbr", "missing-representation");
    const template = decodeUpstream(tampered.searchParams.get("u") || "");
    expect(resolveDashTemplateUpstream(session, template, tampered.searchParams)).toBeNull();
  });

  it("selects the highest-priority sibling BaseURL and preserves its attributes", () => {
    const rewritten = rewriteMpd(fixtureMpd, testSession(), MANIFEST_URL);
    const targets = baseUrlValues(rewritten).map(decodedProxyTarget);

    expect(targets).toEqual([
      "https://media.example/dash/",
      "https://media.example/dash/open-movie/",
      "https://media.example/dash/open-movie/video/",
      "https://media.example/dash/open-movie/video/hd-main/",
      "https://media.example/dash/open-movie/video/main/",
      "https://media.example/dash/open-movie/audio/",
    ]);
    expect(rewritten).toContain(
      '<BaseURL serviceLocation="open-fixture" dvb:priority="1">'
    );
    expect(rewritten).toContain(
      '<BaseURL serviceLocation="uhd" availabilityTimeComplete="false">'
    );
    expect(rewritten).toContain(
      '<BaseURL serviceLocation="video-cdn" dvb:priority="1">'
    );
    expect(rewritten).not.toContain("video-backup");
  });

  it("keeps unformatted Number templates routable through the same session", () => {
    const session = testSession();
    const rewritten = rewriteMpd(fixtureMpd, session, MANIFEST_URL);
    const audioMedia = attributeValues(rewritten, "media")[1] || "";

    expect(audioMedia).toContain("$Number$");
    expect(resolvedTemplateTarget(session, audioMedia)).toBe(
      "https://media.example/dash/open-movie/audio/chunk-7.m4s"
    );
  });

  it("rejects values that are not valid substitutions for the encoded template", () => {
    const session = testSession();
    const rewritten = rewriteMpd(fixtureMpd, session, MANIFEST_URL);
    const media = attributeValues(rewritten, "media")[0] || "";
    const requestUrl = new URL(substituteDashValues(media), "https://cinehome.example");
    const template = decodeUpstream(requestUrl.searchParams.get("u") || "");

    requestUrl.searchParams.set("dv0", "../../other-host");
    expect(resolveDashTemplateUpstream(session, template, requestUrl.searchParams)).toBeNull();
    requestUrl.searchParams.set("dv0", "uhd-2160");
    requestUrl.searchParams.set("dv1", "seven");
    expect(resolveDashTemplateUpstream(session, template, requestUrl.searchParams)).toBeNull();
  });

  it("round-trips reserved Representation IDs without exposing URL delimiters", () => {
    const session = testSession();
    const representationId = "UHD + main@2160";
    const mpd = [
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">',
      "<BaseURL>https://media.example/title/</BaseURL>",
      `<Period><AdaptationSet><Representation id="${representationId}" height="2160">`,
      '<SegmentTemplate media="video/$RepresentationID$/chunk-$Number$.m4s"/>',
      "</Representation></AdaptationSet></Period></MPD>",
    ].join("");
    const rewritten = rewriteMpd(mpd, session, MANIFEST_URL);
    const transportedId =
      rewritten.match(/<Representation\b[^>]*\bid="([^"]+)"/)?.[1] || "";
    const media = attributeValues(rewritten, "media")[0] || "";
    const requestUrl = new URL(
      substituteDashValues(media, transportedId),
      "https://cinehome.example"
    );
    const template = decodeUpstream(requestUrl.searchParams.get("u") || "");

    expect(transportedId).toStartWith("chrep.");
    expect(transportedId).not.toContain(" ");
    expect(transportedId).not.toContain("+");
    expect(resolveDashTemplateUpstream(session, template, requestUrl.searchParams)).toBe(
      "https://media.example/title/video/UHD + main@2160/chunk-7.m4s"
    );
    const tamperedSuffix = transportedId.endsWith("A") ? "B" : "A";
    requestUrl.searchParams.set("dv0", `${transportedId.slice(0, -1)}${tamperedSuffix}`);
    expect(resolveDashTemplateUpstream(session, template, requestUrl.searchParams)).toBeNull();
  });

  it("keeps MPD roots and selected BaseURLs on home when Worker proxying is enabled", () => {
    const previous = {
      enabled: process.env.WORKER_PROXY_ENABLED,
      base: process.env.WORKER_PROXY_BASE,
      secret: process.env.WORKER_PROXY_SECRET,
    };
    process.env.WORKER_PROXY_ENABLED = "1";
    process.env.WORKER_PROXY_BASE = "https://edge.example";
    process.env.WORKER_PROXY_SECRET = "worker-test-secret";
    try {
      const session = testSession();
      const root = buildPlaybackProxyUrl(session);
      const segment = proxyUrlFor(session, "https://media.example/video/chunk-1.m4s");
      const rewritten = rewriteMpd(fixtureMpd, session, MANIFEST_URL);

      expect(root).toStartWith("/api/hls/dash-session?");
      expect(segment).toStartWith("https://edge.example/");
      for (const value of baseUrlValues(rewritten)) {
        expect(value).toStartWith("/api/hls/dash-session?");
      }
    } finally {
      if (previous.enabled === undefined) delete process.env.WORKER_PROXY_ENABLED;
      else process.env.WORKER_PROXY_ENABLED = previous.enabled;
      if (previous.base === undefined) delete process.env.WORKER_PROXY_BASE;
      else process.env.WORKER_PROXY_BASE = previous.base;
      if (previous.secret === undefined) delete process.env.WORKER_PROXY_SECRET;
      else process.env.WORKER_PROXY_SECRET = previous.secret;
    }
  });

  it("fails open without recursion when XML depth exceeds the MPD bound", () => {
    const nesting = 256;
    const deepMpd =
      `<MPD>${"<Period>".repeat(nesting)}` +
      '<SegmentTemplate media="chunk-$Number$.m4s"/>' +
      `${"</Period>".repeat(nesting)}</MPD>`;

    expect(() => rewriteMpd(deepMpd, testSession(), MANIFEST_URL)).not.toThrow();
    expect(rewriteMpd(deepMpd, testSession(), MANIFEST_URL)).toBe(deepMpd);
  });
});
