/* CineHome service worker — PR-11
 *
 * Strategies:
 * - /api/hls, /api/playback  → network-only (never cache streams)
 * - other /api/*             → network-first (no offline stale streams)
 * - /_next/static, icons     → cache-first
 * - navigations              → network-first with offline cache fallback
 */

const CACHE_NAME = "cinehome-static-v3";
const IMAGE_CACHE = "cinehome-images-v1";
const STATIC_ASSETS = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.svg",
  "/logo.svg",
  "/favicon.svg",
];

/** Paths that must never be cached (live playback / HLS proxy). */
function isPlaybackOrHls(pathname) {
  return (
    pathname.startsWith("/api/hls") ||
    pathname.startsWith("/api/playback") ||
    pathname.startsWith("/api/progress")
  );
}

function isApi(pathname) {
  return pathname.startsWith("/api/");
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    STATIC_ASSETS.includes(pathname) ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".woff2")
  );
}

function isPosterImage(url) {
  return url.hostname === "image.tmdb.org" || url.pathname.includes("/t/p/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/**
 * Network-first: try network, fall back to cache on failure.
 * Optionally write successful GETs into cache (for non-stream APIs / pages).
 */
async function networkFirst(request, { cacheResult = false } = {}) {
  try {
    const res = await fetch(request);
    if (cacheResult && res && res.ok && request.method === "GET") {
      const clone = res.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, clone);
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline shell for navigations only handled by caller
    throw new Error("network-first failed offline");
  }
}

/** Cache-first for hashed static assets. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) {
    const clone = res.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, clone);
  }
  return res;
}

/** Network-only — never touch Cache Storage (HLS / playback). */
async function networkOnly(request) {
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // TMDB posters (cross-origin) — cache-first when CORS allows
  if (isPosterImage(url) && request.destination === "image") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request, { mode: "no-cors" });
          // opaque ok to stash
          if (res) await cache.put(request, res.clone());
          return res;
        } catch {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // Only handle same-origin below
  if (url.origin !== self.location.origin) return;

  const { pathname } = url;

  // 1) Playback / HLS / progress — never cache
  if (isPlaybackOrHls(pathname)) {
    event.respondWith(networkOnly(request));
    return;
  }

  // 2) Other APIs — network-first
  if (isApi(pathname)) {
    event.respondWith(
      networkFirst(request, { cacheResult: false }).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    return;
  }

  // 3) Static assets — cache-first
  if (isStaticAsset(pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 4) Navigations — network-first with offline shell fallback
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, { cacheResult: true }).catch(async () => {
        const shell = (await caches.match(request)) || (await caches.match("/"));
        return (
          shell ||
          new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          })
        );
      })
    );
  }
});
