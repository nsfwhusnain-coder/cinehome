#!/usr/bin/env bun
/**
 * Sequential production browser release gate.
 *
 * Each child writes its detailed report/screenshots. This wrapper prevents a
 * green controls pass from hiding a failed terminal-state, Cineby contract, or
 * forced-recovery pass.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Gate {
  name: string;
  script: string;
  env?: Record<string, string>;
}

interface GateResult {
  name: string;
  exitCode: number;
  elapsedMs: number;
}

const OUT_DIR =
  process.env.RELEASE_PASS_OUT_DIR || "/app/.browser-qa/release-pass";
const SKIP_RECOVERY = process.env.RELEASE_SKIP_RECOVERY === "1";

const gates: Gate[] = [
  {
    name: "player-product",
    script: "scripts/browser/player-product-pass.ts",
    env: {
      PLAYER_PRODUCT_OUT_DIR: join(OUT_DIR, "player-product"),
    },
  },
  {
    name: "player-terminal",
    script: "scripts/browser/player-product-pass.ts",
    env: {
      PLAYER_PRODUCT_EXPECT_TERMINAL: "1",
      PLAYER_PRODUCT_VIEWPORT: "desktop",
      PLAYER_PRODUCT_OUT_DIR: join(OUT_DIR, "player-terminal"),
    },
  },
  {
    name: "cineby-player",
    script: "scripts/browser/cineby-player-pass.ts",
    env: {
      CINEBY_PLAYER_OUT_DIR: join(OUT_DIR, "cineby-player"),
    },
  },
  ...(!SKIP_RECOVERY
    ? [
        {
          name: "roster-refresh",
          script: "scripts/browser/roster-refresh-pass.ts",
          env: {
            ROSTER_REFRESH_OUT_DIR: join(OUT_DIR, "roster-refresh"),
          },
        },
      ]
    : []),
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const results: GateResult[] = [];

  for (const gate of gates) {
    const started = Date.now();
    console.log(`RELEASE_GATE START ${gate.name}`);
    const child = Bun.spawn([process.execPath, gate.script], {
      cwd: process.cwd(),
      env: { ...process.env, ...gate.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    const result = {
      name: gate.name,
      exitCode,
      elapsedMs: Date.now() - started,
    };
    results.push(result);
    console.log(
      `RELEASE_GATE ${exitCode === 0 ? "PASS" : "FAIL"} ${gate.name} ${result.elapsedMs}ms`
    );
    if (exitCode !== 0) break;
  }

  const passed = results.length === gates.length && results.every((gate) => gate.exitCode === 0);
  const report = {
    at: new Date().toISOString(),
    passed,
    skippedRecovery: SKIP_RECOVERY,
    results,
  };
  const reportPath = join(OUT_DIR, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`RELEASE_PASS_REPORT ${reportPath}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `RELEASE_PASS_FATAL ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
