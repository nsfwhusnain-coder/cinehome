"use client";

import { Bookmark, Clock, Search, Film, AlertCircle, LayoutGrid, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/hooks/use-navigate";

export function EmptyWatchlist() {
  const navigate = useNavigate();
  return (
    <div className="py-16 text-center">
      <Bookmark className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <h2 className="mb-1 font-display text-lg font-semibold">Your watchlist is empty</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Save titles from the &quot;...&quot; menu on any card — they&apos;ll show up here.
      </p>
      <Button type="button" onClick={() => navigate("/")} className="rounded-full px-6">
        Browse titles
      </Button>
    </div>
  );
}

export function EmptyContinue() {
  const navigate = useNavigate();
  return (
    <div className="py-16 text-center">
      <Clock className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <h2 className="mb-1 font-display text-lg font-semibold">Nothing here yet</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Pick up where you left off — titles you start watching appear here.
      </p>
      <Button type="button" onClick={() => navigate("/")} className="rounded-full px-6">
        Browse titles
      </Button>
    </div>
  );
}

export function EmptySearch({ query }: { query: string }) {
  return (
    <div className="py-16 text-center">
      <Search className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <h2 className="mb-1 font-display text-lg font-semibold">
        No results for &quot;{query}&quot;
      </h2>
      <p className="text-sm text-muted-foreground">
        Try another title, year, or a simpler spelling.
      </p>
    </div>
  );
}

export function NoProvider() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <Film className="h-10 w-10 text-amber-400" />
      <div className="font-display text-lg font-semibold">No playback provider configured</div>
      <p className="max-w-md text-xs text-muted-foreground">
        Playback isn&apos;t set up yet. An admin can configure a provider in Settings.
      </p>
      <Button
        type="button"
        onClick={() => navigate("/settings")}
        size="sm"
        variant="secondary"
        className="mt-1 rounded-full"
      >
        Go to Settings
      </Button>
    </div>
  );
}

export function EmptyBrowse({ label }: { label: string }) {
  const navigate = useNavigate();
  return (
    <div className="py-16 text-center">
      <LayoutGrid className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <h2 className="mb-1 font-display text-lg font-semibold">Nothing in {label}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Try another category or check back later.
      </p>
      <Button type="button" onClick={() => navigate("/")} className="rounded-full px-6">
        Back to Home
      </Button>
    </div>
  );
}

export function PersonError({ onRetry }: { onRetry?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="py-16 text-center">
      <User className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <h1 className="mb-1 font-display text-lg font-semibold">Couldn&apos;t load this person</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        They may have been removed, or the catalog is briefly unavailable.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button type="button" onClick={onRetry} size="sm" variant="secondary" className="rounded-full">
            Try again
          </Button>
        ) : null}
        <Button type="button" onClick={() => navigate("/")} className="rounded-full px-6">
          Back to Home
        </Button>
      </div>
    </div>
  );
}

export function BrowseError({
  label,
  onRetry,
  compact = false,
  hint,
}: {
  label: string;
  onRetry?: () => void;
  compact?: boolean;
  hint?: string;
}) {
  return (
    <div className={compact ? "py-4" : "py-16 text-center"}>
      <AlertCircle
        className={
          compact
            ? "mb-2 h-6 w-6 text-muted-foreground"
            : "mx-auto mb-3 h-12 w-12 text-muted-foreground"
        }
      />
      <h2 className={`mb-1 font-display font-semibold ${compact ? "text-base" : "text-lg"}`}>
        Couldn&apos;t load {label}
      </h2>
      <p className={`mb-3 text-muted-foreground ${compact ? "text-xs" : "text-sm"}`}>
        Something went wrong loading titles. You can try again.
      </p>
      {hint ? <p className="mb-3 text-xs text-muted-foreground/80">{hint}</p> : null}
      {onRetry ? (
        <Button
          type="button"
          onClick={onRetry}
          size="sm"
          variant="secondary"
          className="rounded-full"
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}
