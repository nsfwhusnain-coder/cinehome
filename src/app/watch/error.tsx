"use client";

/**
 * Catches render errors from the immersive /watch shell. New boundary file
 * only — does not touch video-player.tsx / player/** / watch.tsx. Rendered
 * inside watch/layout.tsx's fixed full-viewport black frame, so it should
 * fill that space rather than assume normal page chrome.
 */
import { AlertTriangle } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { useNavigate } from "@/hooks/use-navigate";

export default function WatchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black px-4 text-center text-white">
      <BrandMark size="lg" />
      <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden />
      <div>
        <h1 className="text-xl font-semibold">Playback hit a snag</h1>
        <p className="mt-1.5 max-w-sm text-sm text-white/60">
          {error.message || "Something went wrong loading this player."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-full bg-white px-6 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-full border border-white/30 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}
