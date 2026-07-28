/**
 * Client-side low-priority playback source pre-resolution.
 * Cap 3 concurrent; abort on navigation; skip when saveData.
 */

type Job = {
  url: string;
  key: string;
  abort: AbortController;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

const MAX = 3;
const queue: Job[] = [];
let active = 0;
const activeJobs = new Set<Job>();
const inFlight = new Map<string, Promise<unknown>>();
const memory = new Map<string, { at: number; data: unknown }>();
const MEM_TTL = 45 * 60 * 1000;
/**
 * Hover debounce before kicking preresolve (cards/home already use 150ms).
 * Exported so UI stays aligned if they import it later.
 */
export const HOVER_PRERESOLVE_DELAY_MS = 150;

function saveData(): boolean {
  try {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return Boolean(c?.saveData);
  } catch {
    return false;
  }
}

function pump(): void {
  while (active < MAX && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    activeJobs.add(job);
    globalThis.fetch(job.url, {
      signal: job.abort.signal,
      priority: "low",
    } as RequestInit)
      .then(async (res) => {
        const json = await res.json();
        if (res.ok) {
          memory.set(job.key, { at: Date.now(), data: json });
        }
        job.resolve(json);
      })
      .catch((e: unknown) => {
        if (
          job.abort.signal.aborted ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          job.resolve(null);
          return;
        }
        job.reject(e);
      })
      .finally(() => {
        active -= 1;
        activeJobs.delete(job);
        inFlight.delete(job.key);
        pump();
      });
  }
}

export function buildPlaybackUrl(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number,
  fast = true
): string {
  const params = new URLSearchParams();
  if (mediaType === "tv") {
    params.set("season", String(season && season > 0 ? season : 1));
    params.set("episode", String(episode && episode > 0 ? episode : 1));
  }
  if (fast) params.set("fast", "1");
  params.set("prefetch", "1");
  // Preferred quality for ranking (client Settings). Safe in browser only.
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem("cinehome:preferred-quality");
      if (raw === "auto" || raw === null || raw === "") {
        params.set("qualityHint", "auto");
      } else {
        const n = Number(raw);
        params.set(
          "qualityHint",
          Number.isFinite(n) && [2160, 1440, 1080, 720, 480, 360].includes(n)
            ? String(n)
            : "auto"
        );
      }
    }
  } catch {
    /* ignore */
  }
  return `/api/playback/${mediaType}/${tmdbId}?${params.toString()}`;
}

export function playbackMemKey(
  mediaType: string,
  tmdbId: number,
  season?: number,
  episode?: number
): string {
  return `${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
}

export function getMemPlayback(key: string): unknown | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEM_TTL) {
    memory.delete(key);
    return null;
  }
  return hit.data;
}

/** Queue a low-priority resolve. Cancellation resolves cleanly to `null`. */
export function preresolvePlayback(opts: {
  mediaType: string;
  tmdbId: number;
  season?: number;
  episode?: number;
}): Promise<unknown> {
  if (typeof window === "undefined" || saveData()) {
    return Promise.resolve(null);
  }
  const key = playbackMemKey(opts.mediaType, opts.tmdbId, opts.season, opts.episode);
  const cached = getMemPlayback(key);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const abort = new AbortController();
  const url = buildPlaybackUrl(opts.mediaType, opts.tmdbId, opts.season, opts.episode, true);

  const p = new Promise<unknown>((resolve, reject) => {
    queue.push({ url, key, abort, resolve, reject });
    pump();
  });
  inFlight.set(key, p);
  return p;
}

/** Abort all queued + active jobs (call on navigation). */
export function abortAllPreresolve(): void {
  for (const job of queue) {
    job.abort.abort();
    job.resolve(null);
    inFlight.delete(job.key);
  }
  queue.length = 0;
  for (const job of activeJobs) {
    job.abort.abort();
  }
}

/** Preconnect to stream origin once a source URL is known. */
export function preconnectStreamOrigin(streamUrl: string | null | undefined): void {
  if (!streamUrl || typeof document === "undefined") return;
  try {
    const u = new URL(streamUrl, window.location.origin);
    const origin = u.origin;
    if (document.querySelector(`link[data-preconnect="${origin}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    link.setAttribute("data-preconnect", origin);
    document.head.appendChild(link);
  } catch {
    /* ignore */
  }
}

/**
 * Prefetch HLS master + media playlist + first media segment (same-origin proxy only).
 * Aggressive path: cuts 2–3s off TTFF when hover already resolved a source.
 */
export function prefetchManifestLite(streamUrl: string | null | undefined): void {
  if (!streamUrl || typeof window === "undefined" || saveData()) return;
  try {
    const u = new URL(streamUrl, window.location.origin);
    if (u.origin !== window.location.origin) return;

    const warmPlaylist = async (playlistUrl: string, depth: number): Promise<void> => {
      if (depth > 2) return;
      const res = await fetch(playlistUrl, { priority: "low" } as RequestInit);
      if (!res.ok) return;
      const ct = res.headers.get("content-type") || "";
      const text = await res.text();
      if (!ct.includes("mpegurl") && !text.includes("#EXTM3U")) return;

      const base = new URL(playlistUrl);
      const lines = text.split("\n");
      let segs = 0;
      let nested = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        try {
          const child = new URL(t, base).toString();
          if (t.includes(".m3u8") || child.includes(".m3u8")) {
            if (nested < 1) {
              nested += 1;
              void warmPlaylist(child, depth + 1);
            }
            continue;
          }
          // First media segment(s) — use default priority so cache is hot for play.
          void fetch(child, { priority: segs === 0 ? "high" : "low" } as RequestInit);
          segs += 1;
          if (segs >= 2) break;
        } catch {
          /* skip */
        }
      }
    };

    void warmPlaylist(u.toString(), 0);
  } catch {
    /* ignore */
  }
}
