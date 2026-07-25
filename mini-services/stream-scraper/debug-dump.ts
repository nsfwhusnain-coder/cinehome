/**
 * DEBUG_SCRAPER=true — dumps every intercepted network response seen by the
 * Playwright embed layer (url, status, content-type, size, provider) to a
 * timestamped file under this mini-service's writable dir. Off by default;
 * zero cost (isDebugEnabled short-circuits every call site) when unset.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export interface DebugCapture {
  url: string;
  status: number | null;
  contentType: string;
  size: number | null;
  provider: string;
}

/** Writable dir inside the mini-service; not volume-mounted — ephemeral by design, *.log is gitignored. */
const DEBUG_DIR = join(import.meta.dir, "debug-logs");

export function isDebugEnabled(): boolean {
  const raw = (process.env.DEBUG_SCRAPER || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

let buffer: DebugCapture[] = [];

/** No-op unless DEBUG_SCRAPER is enabled. */
export function recordDebugCapture(capture: DebugCapture): void {
  if (!isDebugEnabled()) return;
  buffer.push(capture);
}

/** Pure formatter — sorted largest-first; unknown sizes sort last. Exported for unit testing. */
export function formatDebugDump(captures: DebugCapture[]): string {
  const sorted = [...captures].sort((a, b) => {
    const aSize = a.size ?? -1;
    const bSize = b.size ?? -1;
    return bSize - aSize;
  });
  const lines = sorted.map((c) => {
    const size = c.size != null ? String(c.size) : "?";
    return `${size.padStart(10)}  ${String(c.status ?? "?").padStart(3)}  ${(c.contentType || "-").padEnd(40)}  [${c.provider}]  ${c.url}`;
  });
  return [
    `# CineHome scraper debug dump — ${sorted.length} intercepted response(s)`,
    `# size(bytes)  status  content-type                              [provider]  url`,
    ...lines,
    "",
  ].join("\n");
}

/** Test helper — current buffered count without flushing. */
export function debugBufferSize(): number {
  return buffer.length;
}

/** Test helper — clears the buffer without writing a file. */
export function resetDebugBuffer(): void {
  buffer = [];
}

/**
 * Flush buffered captures for this scrape pass to a timestamped file and
 * clear the buffer. No-op (returns null) when disabled or nothing captured.
 */
export async function flushDebugDump(): Promise<string | null> {
  if (!isDebugEnabled() || buffer.length === 0) return null;
  const captures = buffer;
  buffer = [];
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(DEBUG_DIR, `scrape-${stamp}.log`);
    await writeFile(filePath, formatDebugDump(captures), "utf8");
    return filePath;
  } catch {
    return null;
  }
}
