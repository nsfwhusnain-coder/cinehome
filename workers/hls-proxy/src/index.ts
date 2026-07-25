/**
 * CineHome HLS edge proxy (Cloudflare Worker).
 *
 * - Requires a signed token minted by CineHome after user sign-in (HMAC-SHA256).
 * - Injects Referer/Origin/UA/cookies for embed CDNs.
 * - Rewrites m3u8/mpd so nested playlists + segments stay on this Worker.
 * - Streams segment bodies (no open unauthenticated proxy).
 */

export interface Env {
  PROXY_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

interface ProxyPayload {
  /** Upstream absolute URL */
  u: string;
  /** Referer */
  r: string;
  /** Origin */
  o: string;
  /** User-Agent */
  a: string;
  /** Cookie header */
  c: string;
  /** Extra headers (JSON object) */
  x: Record<string, string>;
  /** Expiry unix seconds */
  e: number;
  /** CineHome user id (audit / binding) */
  i: string;
}

const MAX_TOKEN_AGE_S = 4 * 60 * 60; // 4h hard ceiling
const FETCH_TIMEOUT_MS = 28_000;

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToB64url(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text));
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64url(sig);
}

async function verifyToken(
  token: string,
  secret: string
): Promise<{ ok: true; payload: ProxyPayload } | { ok: false; error: string }> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed token" };
  const [payloadB64, sig] = parts;
  const expect = await hmacSha256(secret, payloadB64);
  if (sig.length !== expect.length) return { ok: false, error: "bad signature" };
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return { ok: false, error: "bad signature" };

  let payload: ProxyPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as ProxyPayload;
  } catch {
    return { ok: false, error: "bad payload" };
  }

  if (!payload?.u || !payload.e || !payload.i) return { ok: false, error: "incomplete payload" };
  const now = Math.floor(Date.now() / 1000);
  if (payload.e < now) return { ok: false, error: "expired" };
  if (payload.e > now + MAX_TOKEN_AGE_S + 60) return { ok: false, error: "exp too far" };

  let url: URL;
  try {
    url = new URL(payload.u);
  } catch {
    return { ok: false, error: "bad upstream url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "bad protocol" };
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.endsWith(".local")
  ) {
    return { ok: false, error: "private host blocked" };
  }

  return { ok: true, payload };
}

function corsHeaders(request: Request, env: Env): Headers {
  const h = new Headers();
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Signed token is the auth boundary. Reflect allowlisted origins; else omit credentials path.
  if (origin && (allowed.length === 0 || allowed.includes(origin) || allowed.includes("*"))) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  } else if (allowed.includes("*")) {
    h.set("Access-Control-Allow-Origin", "*");
  } else if (allowed[0]) {
    // Browser needs a value when Origin is sent from CineHome; allow first configured origin match fallthrough
    h.set("Access-Control-Allow-Origin", origin || allowed[0]);
    h.set("Vary", "Origin");
  } else {
    h.set("Access-Control-Allow-Origin", "*");
  }
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set(
    "Access-Control-Allow-Headers",
    "Range, Content-Type, Accept, Origin, If-None-Match, If-Modified-Since"
  );
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function buildUpstreamHeaders(payload: ProxyPayload, range: string | null): Headers {
  const h = new Headers();
  h.set("Accept", "*/*");
  h.set("Accept-Language", "en-US,en;q=0.9");
  h.set("User-Agent", payload.a || "Mozilla/5.0");
  if (payload.r) h.set("Referer", payload.r);
  if (payload.o) h.set("Origin", payload.o);
  if (payload.c) h.set("Cookie", payload.c);
  if (payload.x && typeof payload.x === "object") {
    for (const [k, v] of Object.entries(payload.x)) {
      if (v && typeof v === "string") h.set(k, v);
    }
  }
  if (range) h.set("Range", range);
  return h;
}

async function mintToken(payload: ProxyPayload, secret: string): Promise<string> {
  const payloadB64 = textToB64url(JSON.stringify(payload));
  const sig = await hmacSha256(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

async function rewriteM3u8(
  body: string,
  baseUrl: string,
  template: ProxyPayload,
  secret: string,
  workerOrigin: string
): Promise<string> {
  const lines = body.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (/URI=/i.test(trimmed)) {
        let next = trimmed;
        const replaceUri = async (m: string, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          const token = await mintToken({ ...template, u: abs }, secret);
          return `URI="${workerOrigin}/?t=${token}"`;
        };
        next = await replaceAsync(next, /URI="([^"]+)"/gi, replaceUri);
        next = await replaceAsync(next, /URI='([^']+)'/gi, replaceUri);
        out.push(next);
      } else {
        out.push(line);
      }
      continue;
    }
    const abs = resolveUrl(trimmed, baseUrl);
    const token = await mintToken({ ...template, u: abs }, secret);
    out.push(`${workerOrigin}/?t=${token}`);
  }
  return out.join("\n");
}

async function replaceAsync(
  str: string,
  regex: RegExp,
  asyncFn: (match: string, ...args: string[]) => Promise<string>
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  const re = new RegExp(regex.source, regex.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    parts.push(str.slice(last, m.index));
    parts.push(await asyncFn(m[0], m[1]));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join("");
}

function looksLikeM3u8(contentType: string, url: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("m3u8")) return true;
  if (url.includes(".m3u8") || url.includes("playlist")) return true;
  return body.trimStart().startsWith("#EXTM3U");
}

function looksLikeMpd(contentType: string, url: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("dash+xml") || url.includes(".mpd")) return true;
  return body.trimStart().startsWith("<?xml") && body.includes("<MPD");
}

function isSegmentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".ts") ||
    lower.includes(".m4s") ||
    lower.includes(".mp4") ||
    lower.includes(".aac") ||
    lower.includes(".vtt") ||
    lower.includes(".cmfv") ||
    lower.includes(".cmfa")
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    if (!env.PROXY_SECRET) {
      return new Response("Worker misconfigured", { status: 500, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const h = new Headers(cors);
      h.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ ok: true, service: "cinehome-hls-proxy" }), {
        headers: h,
      });
    }

    const token = url.searchParams.get("t") || "";
    if (!token) {
      return new Response("Missing token — sign in to CineHome to play", {
        status: 401,
        headers: cors,
      });
    }

    const verified = await verifyToken(token, env.PROXY_SECRET);
    if (!verified.ok) {
      return new Response(`Unauthorized: ${verified.error}`, { status: 401, headers: cors });
    }

    const payload = verified.payload;
    const range = request.headers.get("Range");
    const upstreamHeaders = buildUpstreamHeaders(payload, range);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(payload.u, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch {
      return new Response("Upstream fetch failed", { status: 502, headers: cors });
    }

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      const h = new Headers(cors);
      return new Response(`Upstream ${upstreamRes.status}`, {
        status: upstreamRes.status,
        headers: h,
      });
    }

    const contentType = upstreamRes.headers.get("content-type") || "";
    const lowerUrl = payload.u.toLowerCase();
    const workerOrigin = url.origin;

    // Manifests: buffer + rewrite so nested URLs stay signed on this Worker
    const maybeManifest =
      !isSegmentUrl(payload.u) ||
      lowerUrl.includes(".m3u8") ||
      lowerUrl.includes("playlist") ||
      lowerUrl.includes(".mpd");

    if (maybeManifest) {
      const text = await upstreamRes.text();
      if (looksLikeM3u8(contentType, payload.u, text)) {
        const rewritten = await rewriteM3u8(text, payload.u, payload, env.PROXY_SECRET, workerOrigin);
        const h = new Headers(cors);
        h.set("Content-Type", "application/vnd.apple.mpegurl");
        h.set("Cache-Control", "no-store");
        return new Response(rewritten, { status: 200, headers: h });
      }
      if (looksLikeMpd(contentType, payload.u, text)) {
        // Minimal MPD absolute-URL rewrite
        const template = payload;
        let body = text;
        const absUrls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
        for (const abs of absUrls) {
          try {
            const host = new URL(abs).hostname;
            if (host.includes("localhost")) continue;
            const t = await mintToken({ ...template, u: abs }, env.PROXY_SECRET);
            body = body.split(abs).join(`${workerOrigin}/?t=${t}`);
          } catch {
            /* skip */
          }
        }
        const h = new Headers(cors);
        h.set("Content-Type", "application/dash+xml");
        h.set("Cache-Control", "no-store");
        return new Response(body, { status: 200, headers: h });
      }
      // Not a manifest — fall through as binary using the text we already read
      const h = new Headers(cors);
      h.set("Content-Type", contentType || "application/octet-stream");
      h.set("Cache-Control", "public, max-age=60");
      return new Response(text, { status: upstreamRes.status, headers: h });
    }

    // Segments: stream through
    const h = new Headers(cors);
    h.set("Content-Type", contentType || "application/octet-stream");
    h.set("Cache-Control", "public, max-age=3600");
    const cr = upstreamRes.headers.get("content-range");
    const cl = upstreamRes.headers.get("content-length");
    const ar = upstreamRes.headers.get("accept-ranges");
    if (cr) h.set("Content-Range", cr);
    if (cl) h.set("Content-Length", cl);
    if (ar) h.set("Accept-Ranges", ar);

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: h });
  },
};
