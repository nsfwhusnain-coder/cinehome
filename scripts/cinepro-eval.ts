#!/usr/bin/env bun
/**
 * Cinepro eval harness — does NOT enable PROVIDER_CINEPRO.
 *
 * Hits cinepro-core (via CINEPRO_URL) for a small diverse TMDB set and prints
 * ok/fail, latency, maxHeight, quality. Writes a recommendation report.
 *
 * Usage:
 *   CINEPRO_URL=http://127.0.0.1:XXXX bun scripts/cinepro-eval.ts
 *   docker exec -e CINEPRO_URL=... cinehome bun /app/scripts/cinepro-eval.ts
 *
 * Exit 0 always when CINEPRO_URL unset/unreachable (KEEP_DISABLED documented).
 * Exit 1 only on unexpected script failure.
 */

import { resolveCinepro, isCineproConfigured } from "../mini-services/stream-scraper/providers/cinepro";
import { inferHeightFromUrl } from "../mini-services/stream-scraper/quality-probe";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const REPORT_PATH = join(
  import.meta.dir,
  "..",
  ".claude",
  "handoffs",
  "cinepro-eval-results.md"
);

/** Circuit comment: re-enable only after PW under 10s + healthy eval. */
const ENABLE_ERR_RATE_MAX = 0.15;
const ENABLE_MIN_SAMPLES = 5;
/** Soft latency ceiling for a "healthy enough to enable" signal (ms). */
const HEALTHY_P95_MS = 15_000;

interface EvalCase {
  name: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
}

const CASES: EvalCase[] = [
  { name: "Fight Club", tmdbId: 550, mediaType: "movie" },
  { name: "Moana 2", tmdbId: 1108427, mediaType: "movie" },
  { name: "Inception", tmdbId: 27205, mediaType: "movie" },
  { name: "Dune Part Two", tmdbId: 693134, mediaType: "movie" },
  { name: "Breaking Bad S1E1", tmdbId: 1396, mediaType: "tv", season: 1, episode: 1 },
  { name: "The Witcher S1E1", tmdbId: 71912, mediaType: "tv", season: 1, episode: 1 },
  { name: "Stranger Things S1E1", tmdbId: 66732, mediaType: "tv", season: 1, episode: 1 },
  { name: "The Office S1E1", tmdbId: 2316, mediaType: "tv", season: 1, episode: 1 },
];

interface CaseResult {
  name: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  ok: boolean;
  latencyMs: number;
  sourceCount: number;
  maxHeight: number;
  qualities: string[];
  labels: string[];
  error?: string;
}

type Recommendation = "KEEP_DISABLED" | "ENABLE_AFTER_48H" | "ENABLE_NOW";

function maxHeightFromSources(
  sources: Array<{ url: string; quality?: string; label?: string }>
): number {
  let best = 0;
  for (const s of sources) {
    const h = inferHeightFromUrl(`${s.url} ${s.label ?? ""} ${s.quality ?? ""}`);
    if (h > best) best = h;
  }
  return best;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  try {
    const streams = await resolveCinepro(c.tmdbId, c.mediaType, c.season, c.episode);
    const latencyMs = Date.now() - started;
    const maxHeight = maxHeightFromSources(streams);
    const qualities = [...new Set(streams.map((s) => s.quality || "auto"))].slice(0, 8);
    const labels = streams.map((s) => s.label).slice(0, 8);
    return {
      name: c.name,
      tmdbId: c.tmdbId,
      mediaType: c.mediaType,
      season: c.season,
      episode: c.episode,
      ok: streams.length > 0,
      latencyMs,
      sourceCount: streams.length,
      maxHeight,
      qualities,
      labels,
    };
  } catch (e: unknown) {
    const latencyMs = Date.now() - started;
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: c.name,
      tmdbId: c.tmdbId,
      mediaType: c.mediaType,
      season: c.season,
      episode: c.episode,
      ok: false,
      latencyMs,
      sourceCount: 0,
      maxHeight: 0,
      qualities: [],
      labels: [],
      error: message,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function recommend(results: CaseResult[], configured: boolean, reachable: boolean): {
  rec: Recommendation;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!configured) {
    reasons.push("CINEPRO_URL unset or off — provider cannot run.");
    return { rec: "KEEP_DISABLED", reasons };
  }
  if (!reachable) {
    reasons.push("cinepro-core unreachable / all cases failed with network errors.");
    return { rec: "KEEP_DISABLED", reasons };
  }

  const n = results.length;
  const fails = results.filter((r) => !r.ok).length;
  const errRate = n > 0 ? fails / n : 1;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95 = percentile(latencies, 0.95);
  const withHeight = results.filter((r) => r.maxHeight >= 1080).length;

  reasons.push(`samples=${n} fail=${fails} errRate=${(errRate * 100).toFixed(1)}%`);
  reasons.push(`latency p95=${p95}ms (healthy ceiling ${HEALTHY_P95_MS}ms)`);
  reasons.push(`titles with token height ≥1080: ${withHeight}/${n}`);
  reasons.push(
    "Circuit policy: PROVIDER_CINEPRO stays opt-in until Playwright is under 10s (see circuit.ts)."
  );

  if (n < ENABLE_MIN_SAMPLES) {
    reasons.push(`Need ≥${ENABLE_MIN_SAMPLES} samples before enable.`);
    return { rec: "KEEP_DISABLED", reasons };
  }
  if (errRate > ENABLE_ERR_RATE_MAX) {
    reasons.push(
      `Error rate ${(errRate * 100).toFixed(1)}% > ${(ENABLE_ERR_RATE_MAX * 100).toFixed(0)}% threshold.`
    );
    return { rec: "KEEP_DISABLED", reasons };
  }
  if (p95 > HEALTHY_P95_MS) {
    reasons.push(`p95 latency high — hold for soak even if error rate is ok.`);
    return { rec: "ENABLE_AFTER_48H", reasons };
  }
  // Healthy numbers alone are not enough without PW <10s production evidence.
  reasons.push(
    "Eval numbers look healthy, but production Playwright is still the gate (enable after PW <10s + 48h soak)."
  );
  return { rec: "ENABLE_AFTER_48H", reasons };
}

function formatTable(results: CaseResult[]): string {
  const header =
    "| Title | TMDB | ok | latency_ms | sources | maxHeight | qualities |";
  const sep = "|-------|------|----|------------|---------|-----------|-----------|";
  const rows = results.map((r) => {
    const id =
      r.mediaType === "tv" && r.season != null && r.episode != null
        ? `${r.tmdbId} S${r.season}E${r.episode}`
        : String(r.tmdbId);
    const q = r.qualities.slice(0, 4).join(", ") || (r.error ? `err: ${r.error}` : "—");
    return `| ${r.name} | ${id} | ${r.ok ? "ok" : "fail"} | ${r.latencyMs} | ${r.sourceCount} | ${r.maxHeight || "—"} | ${q} |`;
  });
  return [header, sep, ...rows].join("\n");
}

function writeReport(opts: {
  configured: boolean;
  reachable: boolean;
  base: string | null;
  results: CaseResult[];
  rec: Recommendation;
  reasons: string[];
}): void {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const now = new Date().toISOString();
  const body = `# Cinepro eval results

**Date:** ${now}  
**CINEPRO_URL:** ${opts.base ?? "(unset)"}  
**PROVIDER_CINEPRO:** remains **disabled** by default (this harness does not flip the kill switch)

## Recommendation

### \`${opts.rec}\`

${opts.reasons.map((r) => `- ${r}`).join("\n")}

## Policy (unchanged)

- \`providers/circuit.ts\`: Cinepro is **opt-in** (\`PROVIDER_CINEPRO=1\`).
- Comment: re-enable after Playwright is under **10s**.
- Research gate: ≤15% err over ≥20 production cycles before \`ENABLE_NOW\`.
- This wave: **eval only — do not re-enable.**

## Cases

${opts.results.length ? formatTable(opts.results) : "_No cases run (CINEPRO_URL unset)._"}

## Labels (first hit samples)

${
  opts.results
    .filter((r) => r.labels.length)
    .map((r) => `- **${r.name}:** ${r.labels.join(", ")}`)
    .join("\n") || "_none_"
}

## How to re-run

\`\`\`bash
# Local / container with cinepro-core
CINEPRO_URL=http://127.0.0.1:PORT bun scripts/cinepro-eval.ts

# Inside cinehome container if core is co-located
docker exec -e CINEPRO_URL="$CINEPRO_URL" cinehome bun /app/scripts/cinepro-eval.ts
\`\`\`
`;
  writeFileSync(REPORT_PATH, body, "utf8");
  console.log(`\nWrote ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  const configured = isCineproConfigured();
  const base = process.env.CINEPRO_URL?.trim() || null;

  console.log("=== Cinepro eval (does not enable PROVIDER_CINEPRO) ===");
  console.log(`CINEPRO_URL: ${base ?? "(unset)"}`);
  console.log(`configured: ${configured}`);

  if (!configured) {
    const { rec, reasons } = recommend([], false, false);
    writeReport({
      configured: false,
      reachable: false,
      base,
      results: [],
      rec,
      reasons,
    });
    console.log(`\nRecommendation: ${rec}`);
    for (const r of reasons) console.log(`  - ${r}`);
    process.exit(0);
  }

  const results: CaseResult[] = [];
  for (const c of CASES) {
    process.stdout.write(`→ ${c.name} ... `);
    const r = await runCase(c);
    results.push(r);
    const status = r.ok ? "ok" : "fail";
    console.log(
      `${status} ${r.latencyMs}ms sources=${r.sourceCount} maxHeight=${r.maxHeight || "—"}` +
        (r.error ? ` (${r.error})` : "")
    );
  }

  const networkFails = results.every(
    (r) =>
      !r.ok &&
      r.error != null &&
      /abort|fetch|econn|enotfound|timeout|cinepro_http/i.test(r.error)
  );
  const anyOk = results.some((r) => r.ok);
  const reachable = anyOk || !networkFails;

  const { rec, reasons } = recommend(results, true, reachable || anyOk);
  writeReport({
    configured: true,
    reachable: anyOk || reachable,
    base,
    results,
    rec,
    reasons,
  });

  console.log("\n" + formatTable(results));
  console.log(`\nRecommendation: ${rec}`);
  for (const r of reasons) console.log(`  - ${r}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("cinepro-eval fatal:", e);
  try {
    writeReport({
      configured: isCineproConfigured(),
      reachable: false,
      base: process.env.CINEPRO_URL?.trim() || null,
      results: [],
      rec: "KEEP_DISABLED",
      reasons: [`Script error: ${e instanceof Error ? e.message : String(e)}`],
    });
  } catch {
    /* ignore */
  }
  process.exit(0);
});
