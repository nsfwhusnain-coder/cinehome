"use client";

/**
 * Catches render/data errors from pages inside the (main) route group
 * (home, detail, browse, search, settings, …). Renders inside MainLayout, so
 * Navbar/Footer/MobileDock stay on screen — never a full blank swap.
 */
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/hooks/use-navigate";

export default function MainSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 pt-20 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden />
      <div>
        <h1 className="font-display text-xl font-semibold">Something went wrong</h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {error.message || "This page couldn't load."}
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
