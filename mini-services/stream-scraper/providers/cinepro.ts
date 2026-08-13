/**
 * CinePro (OMSS) multi-provider resolver — Lordflix-class source fan-out + edge proxy.
 * Calls co-located cinepro-core; rewrites localhost proxy URLs to CINEPRO_URL.
 *
 * Timeout note: one OMSS HTTP call returns all providers together — there is no
 * per-provider (Icefy vs Fshare) timeout inside a single response. We budget the
 * whole call via CINEPRO_FAST_TIMEOUT_MS / CINEPRO_FULL_TIMEOUT_MS only.
 */

import type { ProviderStream } from "./types";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Fast-race budget — keep under FAST_MAX_WAIT (~7.5s) when possible; late-merge still ok. */
export const CINEPRO_FAST_TIMEOUT_MS = 8_000;
/**
 * Full-path ceiling.
 *
 * Raised from 12s to 45s, and this does NOT cost time-to-first-frame. The
 * provider race returns as soon as the first arm produces a source (see
 * FIRST_HIT_SETTLE_MS in index.ts) and caps itself at FULL_API_MAX_WAIT_MS
 * (7.5s) regardless, so by the time CinePro settles the response has long since
 * been sent. A late arm's only job is to call `onLateEntries` and enrich the
 * result cache for the client's progressive poll and the next viewer.
 *
 * 12s was actively throwing that work away: cinepro-core fans out to 14
 * providers and a COLD title is bounded by its slowest one (measured: Videasy
 * ~40s, Peachify ~20s, total 40.7s wall). Every cold title therefore aborted at
 * 12s, contributed nothing, AND recorded a circuit failure for what was really
 * just an impatient budget. Once cinepro-core has cached the title it answers
 * in ~3ms, so this ceiling only ever applies to the first request for a title.
 */
export const CINEPRO_FULL_TIMEOUT_MS = 45_000;
/** Keep more provider streams per title (LordFlix-style multi-server list). */
const MAX_CINEPRO_SOURCES = 16;

export interface ResolveCineproOptions {
  /** Abort budget for the single OMSS HTTP call. Defaults to CINEPRO_FULL_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface CineProProviderMeta {
  id?: string;
  name?: string;
}

interface CineProSource {
  url?: string;
  quality?: string;
  type?: string;
  provider?: CineProProviderMeta | string;
}

interface CineProResponse {
  sources?: CineProSource[];
  error?: unknown;
}

/** Minimal entry shape for Luna / VixSrc de-dupe (SourceEntry-compatible). */
export interface CineproDedupeEntry {
  url: string;
  label: string;
  provider: string;
  /** false = soft-kept failed verify; undefined/true = ok for ranking */
  verified?: boolean;
}

function cineproBase(): string | null {
  const raw = process.env.CINEPRO_URL?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/$/, "");
}

/**
 * Friendly unique labels — each quality/CDN must stay distinct so merge/UI
 * don't collapse 8 Fshare variants into one "Share" row.
 */
function friendlyLabel(
  meta: CineProProviderMeta | string | undefined,
  index: number,
  quality?: string
): string {
  const name =
    typeof meta === "string"
      ? meta
      : (meta?.name || meta?.id || "CinePro").toString();
  const n = name.trim().toLowerCase();
  const q = (quality || "").trim();
  const qSuffix = q && q.toLowerCase() !== "auto" ? ` ${q}` : "";

  // LordFlix-parity names for CinePro's 14 providers (enc-dec Lordflix API is dead).
  if (n.includes("icefy")) return index === 0 ? `Aether${qSuffix}` : `Aether${qSuffix} ${index + 1}`;
  if (n.includes("vidapi")) return index === 0 ? `Horizon${qSuffix}` : `Horizon${qSuffix} ${index + 1}`;
  if (n.includes("vixsrc") || n.includes("vix")) return index === 0 ? "Luna" : `Luna ${index + 1}`;
  if (n.includes("vidnest")) return index === 0 ? `Nest${qSuffix}` : `Nest${qSuffix} ${index + 1}`;
  if (n.includes("vidzee")) return index === 0 ? `Zephyr${qSuffix}` : `Zephyr${qSuffix} ${index + 1}`;
  if (n.includes("peachify")) return index === 0 ? `Sakura${qSuffix}` : `Sakura${qSuffix} ${index + 1}`;
  if (n.includes("tulnex")) return index === 0 ? `Tulip${qSuffix}` : `Tulip${qSuffix} ${index + 1}`;
  if (n.includes("vidsrc")) return index === 0 ? `Orion${qSuffix}` : `Orion${qSuffix} ${index + 1}`;
  if (n.includes("videasy")) return index === 0 ? `Quasar${qSuffix}` : `Quasar${qSuffix} ${index + 1}`;
  if (n.includes("popr")) return index === 0 ? `Pop${qSuffix}` : `Pop${qSuffix} ${index + 1}`;
  if (n.includes("mafia")) return index === 0 ? `Rio${qSuffix}` : `Rio${qSuffix} ${index + 1}`;
  if (n.includes("vidrock")) return index === 0 ? `Rock${qSuffix}` : `Rock${qSuffix} ${index + 1}`;
  if (n.includes("cinesu")) return index === 0 ? `Flower${qSuffix}` : `Flower${qSuffix} ${index + 1}`;
  if (n.includes("fshare")) {
    if (index === 0) return `Share${qSuffix || " 1"}`;
    return `Share${qSuffix} ${index + 1}`.replace(/\s+/g, " ").trim();
  }
  if (n.includes("vidking")) return index === 0 ? "Solstice" : `Solstice ${index + 1}`;
  if (n.includes("vidlink")) return index === 0 ? "Phoenix" : `Phoenix ${index + 1}`;

  const base = name.replace(/[^a-zA-Z0-9]+/g, " ").trim() || "CinePro";
  if (index === 0) return `${base}${qSuffix}`.trim();
  return `${base}${qSuffix} ${index + 1}`.trim();
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "0.0.0.0"
  );
}

/**
 * Rewrite CinePro raw proxy URLs (`localhost:3000/v1/proxy`, any host:3000)
 * onto the reachable CINEPRO_URL base (e.g. `http://cinepro-core:3000`).
 */
export function rewriteProxyUrl(url: string, base: string): string {
  try {
    const parsed = new URL(url);
    const isProxyPath =
      parsed.pathname.includes("/v1/proxy") || parsed.pathname.includes("/proxy");
    // CinePro returns http://localhost:3000/v1/proxy?... — rewrite to reachable base.
    if (isProxyPath && (isLoopbackHost(parsed.hostname) || parsed.port === "3000")) {
      return `${base}${parsed.pathname}${parsed.search}`;
    }
    if (url.includes("/v1/proxy") && !isLoopbackHost(parsed.hostname)) {
      return url;
    }
  } catch {
    /* fall through */
  }
  if (url.startsWith("/v1/")) return `${base}${url}`;
  return url;
}

function providerName(meta: CineProProviderMeta | string | undefined): string {
  if (typeof meta === "string") return meta || "CinePro";
  return meta?.name || meta?.id || "CinePro";
}

/**
 * CinePro sub-providers that reliably answer with something other than video.
 *
 * Icefy ("Aether") serves ad tiles — its playlist resolves, but the segment body
 * is a PNG/JPEG rather than media. This is not a new discovery: `verifyHlsServer`
 * in index.ts has carried an explicit "Icefy/Aether ad tiles (PNG/JPEG) — not
 * playable video" check for some time. Measured again 2026-07-30 across Fight
 * Club, The Dark Knight, Breaking Bad S1E1 and Game of Thrones S1E1: 0/4
 * playable, ad tile every time.
 *
 * Verification already soft-keeps it (`verified: false`) so it never auto-plays
 * and never reaches the Servers panel — dropping it here simply stops paying for
 * the resolve and the verification round trip, and stops padding the payload
 * with a row nothing can use. Keep this list tight and evidence-backed: a
 * sub-provider that merely misses a title must NOT be added.
 */
const DEAD_SUBPROVIDERS = new Set(["icefy"]);

function isDeadSubprovider(meta: CineProProviderMeta | string | undefined): boolean {
  return DEAD_SUBPROVIDERS.has(providerName(meta).trim().toLowerCase());
}

/** Native scraper Vixsrc API entry (provider "Vixsrc", label Luna). */
export function isNativeVixsrcEntry(entry: CineproDedupeEntry): boolean {
  const p = entry.provider.trim().toLowerCase();
  const l = entry.label.trim().toLowerCase();
  if (p.includes("cinepro")) return false;
  return p === "vixsrc" || p.includes("vixsrc") || l === "luna" || l.startsWith("luna ");
}

/** CinePro-wrapped VixSrc (provider CinePro/VixSrc, label Luna). */
export function isCineproVixsrcEntry(entry: CineproDedupeEntry): boolean {
  const p = entry.provider.trim().toLowerCase();
  if (!p.includes("cinepro")) return false;
  const l = entry.label.trim().toLowerCase();
  return p.includes("vix") || l === "luna" || l.startsWith("luna ");
}

function entryPlayable(entry: CineproDedupeEntry): boolean {
  // Soft-kept failed verify is verified:false; undefined/true counts as usable.
  return entry.verified !== false;
}

/**
 * Drop double Luna: when native Vixsrc and CinePro/VixSrc both present, keep one.
 * Prefer native when playable (direct CDN, no proxy hop); keep CinePro only when
 * native is soft-failed and CinePro is still playable.
 *
 * Implemented at merge time (not inside resolveCinepro) so fast/full both benefit
 * once Luna and CinePro arms combine.
 */
export function dedupeCineproVixsrcAgainstNative<T extends CineproDedupeEntry>(
  entries: T[]
): T[] {
  const hasNative = entries.some(isNativeVixsrcEntry);
  const hasCineproVix = entries.some(isCineproVixsrcEntry);
  if (!hasNative || !hasCineproVix) return entries;

  const nativePlayable = entries.some(
    (e) => isNativeVixsrcEntry(e) && entryPlayable(e)
  );
  const cineproPlayable = entries.some(
    (e) => isCineproVixsrcEntry(e) && entryPlayable(e)
  );

  // Native soft-failed, CinePro still ok → drop native Luna, keep CinePro proxy.
  if (!nativePlayable && cineproPlayable) {
    return entries.filter((e) => !isNativeVixsrcEntry(e));
  }
  // Default: drop CinePro VixSrc/Luna (prefer direct native when present).
  return entries.filter((e) => !isCineproVixsrcEntry(e));
}

/**
 * Resolve streams via local CinePro core (14+ providers + built-in proxy).
 * Returns [] when CINEPRO_URL unset.
 * On timeout/HTTP failure: throws so the circuit can record failure.
 */
export async function resolveCinepro(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  opts?: ResolveCineproOptions
): Promise<ProviderStream[]> {
  const base = cineproBase();
  if (!base) return [];

  const timeoutMs =
    opts?.timeoutMs != null && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : CINEPRO_FULL_TIMEOUT_MS;

  const path =
    mediaType === "tv" && season != null && episode != null
      ? `/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`
      : `/v1/movies/${tmdbId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": DEFAULT_UA },
    });
    if (!res.ok) {
      throw new Error(`cinepro_http_${res.status}`);
    }
    const data = (await res.json()) as CineProResponse;
    const raw = data.sources ?? [];
    if (!raw.length) return [];

    const out: ProviderStream[] = [];
    const seen = new Set<string>();
    // Per-friendly-base counters so quality rungs stay unique.
    const labelCounts = new Map<string, number>();

    for (const src of raw) {
      if (!src.url || out.length >= MAX_CINEPRO_SOURCES) break;
      if (isDeadSubprovider(src.provider)) continue;
      const rewritten = rewriteProxyUrl(src.url, base);
      if (!rewritten || seen.has(rewritten)) continue;
      const typ = (src.type || "").toLowerCase();
      if (typ && typ !== "hls" && typ !== "mp4" && typ !== "dash" && typ !== "file") {
        continue;
      }
      seen.add(rewritten);
      const quality = String(src.quality || "auto");
      const baseLabel = friendlyLabel(src.provider, 0, quality);
      const count = labelCounts.get(baseLabel) ?? 0;
      labelCounts.set(baseLabel, count + 1);
      const label =
        count === 0 ? baseLabel : friendlyLabel(src.provider, count, quality);
      const pname = providerName(src.provider).toLowerCase();
      const isVix = pname.includes("vix") || label.toLowerCase().startsWith("luna");
      out.push({
        url: rewritten,
        quality,
        label,
        provider: `CinePro/${providerName(src.provider)}`,
        ...(typ
          ? {
              type: (typ === "file" ? "mp4" : typ) as
                | "hls"
                | "mp4"
                | "dash",
            }
          : {}),
        referer: isVix ? "https://vixsrc.to/" : base,
        origin: isVix ? "https://vixsrc.to" : base,
        userAgent: DEFAULT_UA,
      });
    }
    return out;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "AbortError" || /aborted/i.test(msg)) {
      throw new Error(`cinepro_timeout_${timeoutMs}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function isCineproConfigured(): boolean {
  return cineproBase() != null;
}
