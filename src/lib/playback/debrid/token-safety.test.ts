/// <reference types="bun-types" />
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolveTokenFreeRedirect, sanitizeStreamUrl, sanitizeTorboxStreamUrl } from "./token-safety";

/**
 * CRITICAL regression coverage: the owner's live Real-Debrid API token must
 * never reach a client or the CachedStream cache. Torrentio's RD-configured
 * index echoes the token back in a stream `url` field of the exact shape
 * below — this is the leak the whole module (see index.ts) is built to
 * neutralize. These tests exercise the choke point (`sanitizeStreamUrl`)
 * directly, and the network-resolving path (`resolveTokenFreeRedirect`)
 * against a REAL local HTTP server (not a mock of shipped code) so the
 * actual fetch/redirect-follow logic is exercised end-to-end.
 */

const FAKE_TOKEN = "FAKETOKEN123";
const LEAKY_URL = `https://torrentio.strem.fun/resolve/realdebrid/${FAKE_TOKEN}/HASH/null/0/movie.mp4`;
const CLEAN_CDN_URL = "https://51.download.real-debrid.com/d/ABCDEFGHIJK/Movie.2024.1080p.mp4";

describe("sanitizeStreamUrl — choke point (pure, no network)", () => {
  it("(a) never returns the exact leaky Torrentio resolve shape as-is — it is dropped", () => {
    expect(sanitizeStreamUrl(LEAKY_URL, FAKE_TOKEN)).toBeNull();
  });

  it("(b) drops any URL containing the token string, even outside a /resolve/ path", () => {
    const url = `https://example.com/d/${FAKE_TOKEN}/whatever.mp4`;
    expect(sanitizeStreamUrl(url, FAKE_TOKEN)).toBeNull();
  });

  it("(b) drops any /resolve/realdebrid/ URL even when no token is known to compare against (read-path defense)", () => {
    expect(sanitizeStreamUrl(LEAKY_URL, null)).toBeNull();
  });

  it("drops AllDebrid Torrentio resolve-proxy URLs the same way", () => {
    expect(
      sanitizeStreamUrl(
        "https://torrentio.strem.fun/resolve/alldebrid/SECRET/abcdef0123456789abcdef0123456789abcdef01/null/0/movie.mp4",
        null
      )
    ).toBeNull();
  });

  it("(b) drops a percent-encoded occurrence of the token too", () => {
    const encoded = encodeURIComponent("token/with/slashes");
    const url = `https://example.com/d/${encoded}/whatever.mp4`;
    expect(sanitizeStreamUrl(url, "token/with/slashes")).toBeNull();
  });

  it("(c) passes a normal token-free Real-Debrid CDN URL through unchanged", () => {
    expect(sanitizeStreamUrl(CLEAN_CDN_URL, FAKE_TOKEN)).toBe(CLEAN_CDN_URL);
  });

  it("returns null for empty/missing input rather than throwing", () => {
    expect(sanitizeStreamUrl(null, FAKE_TOKEN)).toBeNull();
    expect(sanitizeStreamUrl(undefined, FAKE_TOKEN)).toBeNull();
    expect(sanitizeStreamUrl("", FAKE_TOKEN)).toBeNull();
  });
});

describe("resolveTokenFreeRedirect — real server-side redirect-follow against a local test server", () => {
  const CLEAN_PATH = "/cdn/d/ABCDEFGHIJK/movie.mp4";
  const LOOP_PATH = "/resolve-loop-token";
  let server: ReturnType<typeof Bun.serve>;
  let cleanMediaFetches = 0;

  beforeAll(() => {
    // Stands in for torrentio.strem.fun's resolve-proxy endpoint: a real
    // HTTP server the shipped `resolveTokenFreeRedirect` fetches against
    // exactly as it would the real Torrentio host. Nothing about the
    // function under test is mocked or stubbed — only the network boundary
    // (which host we point it at) is swapped for the test.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/resolve/realdebrid/")) {
          return new Response(null, { status: 302, headers: { Location: CLEAN_PATH } });
        }
        if (pathname === LOOP_PATH) {
          // Simulates a misbehaving endpoint whose redirect target still
          // carries the token — must still never be returned.
          return new Response(null, {
            status: 302,
            headers: { Location: `/still/${FAKE_TOKEN}/leak.mp4` },
          });
        }
        if (pathname === CLEAN_PATH) {
          cleanMediaFetches += 1;
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  it("(a) follows the leaky resolve shape server-side and yields the final token-free URL — never the token-bearing URL itself", async () => {
    cleanMediaFetches = 0;
    const resolveUrl = `http://127.0.0.1:${server.port}/resolve/realdebrid/${FAKE_TOKEN}/HASH/null/0/movie.mp4`;
    const result = await resolveTokenFreeRedirect(resolveUrl, FAKE_TOKEN);
    expect(result).toBe(`http://127.0.0.1:${server.port}${CLEAN_PATH}`);
    expect(result).not.toContain(FAKE_TOKEN);
    expect(result).not.toMatch(/\/resolve\/realdebrid\//);
    expect(cleanMediaFetches).toBe(0);
  });

  it("returns null (never the token-bearing URL) when the redirect target still carries the token", async () => {
    const resolveUrl = `http://127.0.0.1:${server.port}${LOOP_PATH}`;
    const result = await resolveTokenFreeRedirect(resolveUrl, FAKE_TOKEN);
    expect(result).toBeNull();
  });

  it("returns null on an unreachable host rather than throwing or leaking the input URL", async () => {
    const result = await resolveTokenFreeRedirect(
      `http://127.0.0.1:1/resolve/realdebrid/${FAKE_TOKEN}/HASH/null/0/movie.mp4`,
      FAKE_TOKEN
    );
    expect(result).toBeNull();
  });
});

/**
 * TorBox regression coverage (see torbox.ts): TorBox's `requestdl` endpoint
 * authorizes via a `token` QUERY param rather than a header, and its
 * `data` field is documented (TorBox SDK models) to already be a token-free
 * CDN URL — but exactly like the RD path, we never trust that blindly.
 * `sanitizeTorboxStreamUrl` is the equivalent choke point.
 */
describe("sanitizeTorboxStreamUrl — choke point (pure, no network)", () => {
  const FAKE_KEY = "TORBOXFAKEKEY456";
  const LEAKY_REQUESTDL_URL = `https://api.torbox.app/v1/api/torrents/requestdl?token=${FAKE_KEY}&torrent_id=1&file_id=0`;
  const CLEAN_CDN_URL = "https://store.torbox.app/d/ABCDEFGHIJK/Movie.2024.1080p.mkv";

  it("(a) drops any URL still pointing at TorBox's own requestdl path", () => {
    expect(sanitizeTorboxStreamUrl(LEAKY_REQUESTDL_URL, FAKE_KEY)).toBeNull();
  });

  it("(b) drops any URL containing the raw API key string, even outside the requestdl path", () => {
    const url = `https://example.com/d/${FAKE_KEY}/whatever.mkv`;
    expect(sanitizeTorboxStreamUrl(url, FAKE_KEY)).toBeNull();
  });

  it("(b) drops the requestdl shape even when no key is known to compare against (read-path defense)", () => {
    expect(sanitizeTorboxStreamUrl(LEAKY_REQUESTDL_URL, null)).toBeNull();
  });

  it("(b) drops a percent-encoded occurrence of the key too", () => {
    const encoded = encodeURIComponent("key/with/slashes");
    const url = `https://example.com/d/${encoded}/whatever.mkv`;
    expect(sanitizeTorboxStreamUrl(url, "key/with/slashes")).toBeNull();
  });

  it("(c) passes a normal token-free TorBox CDN URL through unchanged", () => {
    expect(sanitizeTorboxStreamUrl(CLEAN_CDN_URL, FAKE_KEY)).toBe(CLEAN_CDN_URL);
  });

  it("returns null for empty/missing input rather than throwing", () => {
    expect(sanitizeTorboxStreamUrl(null, FAKE_KEY)).toBeNull();
    expect(sanitizeTorboxStreamUrl(undefined, FAKE_KEY)).toBeNull();
    expect(sanitizeTorboxStreamUrl("", FAKE_KEY)).toBeNull();
  });
});
