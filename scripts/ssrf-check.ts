/**
 * Standalone SSRF regression check for the hls-proxy host validator (KD-SSRF).
 *
 * Exercises `isPrivateHostname` — the function `isAllowedUpstreamUrl` and the
 * manual-redirect hop validator in `fetchUpstreamSafely` both build on — against
 * the private/internal address classes the segment proxy must never fetch:
 * cloud metadata (169.254.169.254), this server's own Tailscale CGNAT address
 * (100.64.0.0/10), 0.0.0.0, IPv6 loopback/link-local/IPv4-mapped forms, and
 * standard RFC1918 space. A normal public host must still pass through.
 *
 * Run: `npx tsx scripts/ssrf-check.ts` (or `bun scripts/ssrf-check.ts` where
 * bun is available — no bundler-specific syntax is used).
 */
import { isPrivateHostname } from "../src/lib/hls-proxy";

interface Case {
  input: string;
  expectPrivate: boolean;
  note: string;
}

const cases: Case[] = [
  { input: "169.254.169.254", expectPrivate: true, note: "cloud metadata" },
  { input: "100.89.184.84", expectPrivate: true, note: "this server's Tailscale CGNAT IP" },
  { input: "0.0.0.0", expectPrivate: true, note: "0.0.0.0/8 this-host" },
  { input: "::1", expectPrivate: true, note: "IPv6 loopback" },
  { input: "[::ffff:127.0.0.1]", expectPrivate: true, note: "IPv4-mapped IPv6 loopback (bracketed)" },
  { input: "fe80::1", expectPrivate: true, note: "IPv6 link-local" },
  { input: "10.0.0.5", expectPrivate: true, note: "RFC1918 10.0.0.0/8" },
  { input: "cdn.example.net", expectPrivate: false, note: "normal public host" },
];

let failures = 0;

for (const c of cases) {
  const got = isPrivateHostname(c.input);
  const pass = got === c.expectPrivate;
  if (!pass) failures += 1;
  const verdict = pass ? "PASS" : "FAIL";
  const expected = c.expectPrivate ? "BLOCKED" : "ALLOWED";
  const actual = got ? "BLOCKED" : "ALLOWED";
  process.stdout.write(
    `[${verdict}] ${c.input.padEnd(24)} expected=${expected.padEnd(8)} actual=${actual.padEnd(8)} (${c.note})\n`
  );
}

if (failures > 0) {
  process.stdout.write(`\n${failures}/${cases.length} case(s) FAILED\n`);
  process.exit(1);
}

process.stdout.write(`\nAll ${cases.length} cases PASSED\n`);
