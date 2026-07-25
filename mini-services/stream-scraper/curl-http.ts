import { mkdtemp, readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

export interface CurlResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: Buffer;
  text: string;
  headers: Record<string, string>;
}

export interface CurlRequestOptions {
  headers?: Record<string, string>;
  timeoutSec?: number;
}

function parseResponseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
  const last = blocks[blocks.length - 1] ?? "";
  for (const line of last.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

export async function curlGet(url: string, options: CurlRequestOptions = {}): Promise<CurlResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "cinehome-curl-"));
  const bodyPath = join(tmpDir, "body");
  const headerPath = join(tmpDir, "headers");
  const timeoutSec = options.timeoutSec ?? 25;

  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(timeoutSec),
    "-D",
    headerPath,
    "-o",
    bodyPath,
    "-w",
    "%{http_code}",
  ];

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value) args.push("-H", `${key}: ${value}`);
  }
  args.push(url);

  const statusCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `curl exited ${code}`));
        return;
      }
      const status = parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(status) ? status : 0);
    });
    proc.on("error", reject);
  });

  try {
    const body = await readFile(bodyPath);
    const headerRaw = await readFile(headerPath, "utf8").catch(() => "");
    const parsedHeaders = parseResponseHeaders(headerRaw);
    const contentType = parsedHeaders["content-type"] ?? "";
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      contentType,
      body,
      text: body.toString("utf8"),
      headers: parsedHeaders,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}