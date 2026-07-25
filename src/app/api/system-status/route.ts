import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getProxyMetrics } from "@/lib/hls-proxy";
import { getAuthenticatedUser } from "@/lib/auth";

/** Derive scraper /health base from SCRAPER_URL (…/scrape → …/health). */
function scraperHealthUrl(): string {
  const base = process.env.SCRAPER_URL || "http://127.0.0.1:3030/scrape";
  try {
    const u = new URL(base);
    // Strip trailing /scrape or /prefetch if present
    u.pathname = u.pathname.replace(/\/(scrape|prefetch)\/?$/, "") || "/";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    u.pathname += "health";
    u.search = "";
    return u.toString();
  } catch {
    return "http://127.0.0.1:3030/health";
  }
}

export interface CircuitSnapshotDto {
  state: "closed" | "open" | "half_open";
  enabled: boolean;
  samples: number;
  errors: number;
  errorRate: number;
  openedAt: number | null;
  openUntil: number | null;
  lastMs: number | null;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface ScraperHealthDto {
  ok: boolean;
  browsers?: number;
  queued?: number;
  pool?: {
    size: number;
    max: number;
    queued: number;
    warming: boolean;
  };
  circuits?: Record<string, CircuitSnapshotDto>;
  timings?: Record<
    string,
    { lastMs: number | null; lastAt: number | null; lastOk: boolean | null }
  >;
  lastScrape?: {
    at: number;
    key: string;
    fast: boolean;
    totalMs: number;
    providers?: unknown;
  } | null;
  logLevel?: string;
  error?: string;
}

async function checkDb(): Promise<"ok" | "error"> {
  try {
    await db.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

async function fetchScraperHealth(): Promise<{
  status: "ok" | "error";
  health: ScraperHealthDto | null;
}> {
  try {
    const res = await fetch(scraperHealthUrl(), {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        status: "error",
        health: { ok: false, error: `HTTP ${res.status}` },
      };
    }
    const data = (await res.json()) as ScraperHealthDto;
    return {
      status: data.ok === false ? "error" : "ok",
      health: data,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      health: { ok: false, error: message },
    };
  }
}

/**
 * KD-sec fix #3: this leaks scraper circuit-breaker state, cache byte totals,
 * and DB health — internal ops detail that shouldn't be reachable by anyone
 * who finds the URL. Admin-only, matching /api/debrid/status.
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const [dbStatus, scraper] = await Promise.all([checkDb(), fetchScraperHealth()]);
  const proxy = getProxyMetrics();

  const body = {
    ok: dbStatus === "ok" && scraper.status === "ok",
    db: dbStatus,
    /** Coarse status for healthchecks / simple badges */
    scraper: scraper.status,
    /** Full scraper /health payload (circuits, pool, timings) when reachable */
    scraperHealth: scraper.health,
    proxy: {
      hits: proxy.hits,
      misses: proxy.misses,
      errors: proxy.errors,
      hitRate: Math.round(proxy.hitRate * 1000) / 1000,
      entries: proxy.entries,
      bytesCached: proxy.bytesCached,
      maxEntries: proxy.maxEntries,
      maxBytes: proxy.maxBytes,
      staleHits: proxy.staleHits ?? 0,
      negativeHits: proxy.negativeHits ?? 0,
      manifestEntries: proxy.manifestEntries ?? 0,
      cacheKeyMode: proxy.cacheKeyMode ?? "hybrid-global-cdn-segments",
    },
  };

  if (dbStatus === "ok" && scraper.status === "error") {
    return NextResponse.json(body, { status: 503 });
  }

  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}
