/**
 * Token-safety choke point for the PREMIUM debrid tier.
 *
 * Torrentio's RD-configured index sometimes echoes back a stream `url`
 * pointing at ITS OWN resolve-proxy endpoint:
 *   https://torrentio.strem.fun/resolve/realdebrid/<RD_TOKEN>/<hash>/null/<fileIdx>/<filename>
 * That endpoint is a SERVER-SIDE redirect: fetching it performs the RD
 * resolution and 302s to the final, token-free Real-Debrid CDN link (e.g.
 * `https://<host>.download.real-debrid.com/d/<id>/<filename>`). The token
 * only ever lives in that intermediate resolve URL — it must never leave
 * this module, never become a `PlaybackSource.url`, and never be persisted
 * in `CachedStream.url`.
 *
 * Every candidate URL — from a fresh Torrentio/RD resolve OR read back out
 * of the `CachedStream` cache — MUST pass through `sanitizeStreamUrl` before
 * it is used to build a `PlaybackSource` or a cache row. If it can't be
 * reduced to a safe, token-free URL, the caller drops the source (fail
 * safe: a missing 4K option is fine, a leaked token is not).
 *
 * Never logs the token or any token-bearing URL.
 */

/** Torrentio's own resolve-proxy shape — always unsafe to hand to a client as-is. */
const RESOLVE_PROXY_PATTERN = /\/resolve\/realdebrid\//i;
const RESOLVE_TIMEOUT_MS = 8_000;

/**
 * Pure, network-free choke point. Rejects (returns null) any URL that:
 *  - still points at a Torrentio resolve-proxy path (`/resolve/realdebrid/`), or
 *  - contains the literal configured RD token (raw or percent-encoded).
 * `token` may be null on read paths where the caller still wants the
 * resolve-proxy-pattern check applied even without a token to compare
 * against. Never throws. Never logs the input.
 */
export function sanitizeStreamUrl(url: string | null | undefined, token: string | null): string | null {
  if (!url) return null;
  if (RESOLVE_PROXY_PATTERN.test(url)) return null;
  if (token) {
    if (url.includes(token)) return null;
    const encoded = encodeURIComponent(token);
    if (encoded !== token && url.includes(encoded)) return null;
  }
  return url;
}

/**
 * Resolves a Torrentio `.../resolve/realdebrid/<token>/...` URL server-side
 * to its token-free Location target. The token-bearing URL is used ONLY
 * inside this manual-redirect fetch — it is never returned, stored, or
 * logged. The final RD object is deliberately never fetched server-side.
 *
 * Bounded by an 8s timeout by default; never throws. Returns null on any
 * failure, or if the Location URL doesn't pass `sanitizeStreamUrl` (e.g. it
 * still carries the token or points at the resolve endpoint).
 *
 * `timeoutMs` lets a caller with its own shared wall-clock deadline (see
 * index.ts's slot resolve loop — the "hard overall deadline" for the rich
 * multi-slot roster) clamp this call to whatever time actually remains,
 * rather than always spending the full 8s ceiling. Defaults to the original
 * fixed budget for any caller that doesn't need deadline-awareness.
 * `timeoutMs <= 0` short-circuits to null with no network call at all.
 */
export async function resolveTokenFreeRedirect(
  resolveUrl: string,
  token: string | null,
  timeoutMs: number = RESOLVE_TIMEOUT_MS
): Promise<string | null> {
  if (timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response: Response;
  try {
    response = await fetch(resolveUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }

  const location = response.headers.get("location");
  const responseStatus = response.status;
  const responseUrl = response.url || resolveUrl;
  // We need only the redirect headers. Abort before any final media body can
  // be drained by Bun after this function returns.
  controller.abort("debrid redirect headers received");
  void response.body?.cancel().catch(() => undefined);

  if (responseStatus >= 300 && responseStatus < 400 && location) {
    try {
      return sanitizeStreamUrl(new URL(location, responseUrl).toString(), token);
    } catch {
      return null;
    }
  }

  if (responseStatus < 200 || responseStatus >= 300) return null;
  return sanitizeStreamUrl(responseUrl, token);
}

/** TorBox's own `requestdl` endpoint shape — its `token` query param authorizes the request; the returned CDN link must never carry it either. */
const TORBOX_REQUESTDL_PATTERN = /\/v1\/api\/torrents\/requestdl\b/i;

/**
 * TorBox counterpart to `sanitizeStreamUrl` for the sibling TorBox tier
 * (torbox.ts). TorBox's `requestdl` endpoint takes the API key as a QUERY
 * PARAMETER (not a header) to authorize the download request, and per the
 * TorBox SDK's response model is documented to return a plain, already-
 * resolved CDN URL in `data` — but exactly like the Real-Debrid path, we
 * never trust that blindly. Same fail-safe contract as `sanitizeStreamUrl`:
 * drop (return null) rather than ever hand back a URL that still carries the
 * raw TorBox API key (literal or percent-encoded), or one that still points
 * at TorBox's own authorized `requestdl` path (which requires the key to hit
 * again and is never itself a safe client-facing URL). Never throws. Never
 * logs the input.
 */
export function sanitizeTorboxStreamUrl(url: string | null | undefined, apiKey: string | null): string | null {
  if (!url) return null;
  if (TORBOX_REQUESTDL_PATTERN.test(url)) return null;
  if (apiKey) {
    if (url.includes(apiKey)) return null;
    const encoded = encodeURIComponent(apiKey);
    if (encoded !== apiKey && url.includes(encoded)) return null;
  }
  return url;
}
