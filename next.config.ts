import path from "path";
import type { NextConfig } from "next";

/**
 * Security response headers (KD-sec fix #5).
 *
 * No Content-Security-Policy here on purpose: the player stack (hls.js/dash.js)
 * relies on blob: worker URLs and MSE, the app fetches TMDB images from a
 * multi-subdomain CDN and proxies debrid/CDN media through a Cloudflare
 * worker, and several UI primitives (Radix/shadcn) inject inline styles at
 * runtime. Getting all of that into one CSP without a live app to iterate
 * against risks silently breaking playback (the one thing this pass must not
 * do) — tracked as a follow-up for the boss to add + test against a running
 * instance rather than guessed here.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
