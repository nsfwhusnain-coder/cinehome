"use client";

/**
 * Catches errors thrown by (main)/layout.tsx or watch/layout.tsx (a segment's
 * own error.tsx never catches errors in that same segment's layout — this is
 * the nearest boundary above both route groups). Root layout already mounted
 * successfully here, so Providers/session/query-client are available.
 */
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { useNavigate } from "@/hooks/use-navigate";

export default function RootSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <BrandMark size="lg" />
      <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden />
      <div>
        <h1 className="font-display text-xl font-semibold">Something went wrong</h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred loading this page."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={() => reset()} className="rounded-full px-6">
          Try again
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate("/")}
          className="rounded-full px-6"
        >
          Back to Home
        </Button>
      </div>
    </div>
  );
}
