"use client";

/**
 * Last-resort boundary — only fires when the ROOT layout itself throws, so it
 * replaces the entire <html> document (Providers/SessionProvider/QueryClient
 * never mounted). Keep this self-contained: no hooks that assume app context.
 */
import "./globals.css";
import { BrandMark } from "@/components/brand-mark";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0f] text-white antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-4 text-center">
          <BrandMark size="lg" />
          <div>
            <h1 className="text-xl font-semibold">Something broke</h1>
            <p className="mt-1.5 max-w-sm text-sm text-white/60">
              Absolute Cinema hit an unexpected error and couldn&apos;t recover on its own.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-full bg-white px-6 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]"
            >
              Try again
            </button>
            <a
              href="/"
              className="rounded-full border border-white/30 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]"
            >
              Back to Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
