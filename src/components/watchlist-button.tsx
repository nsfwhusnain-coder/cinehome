"use client";

import { Plus, Check } from "lucide-react";
import { useSession } from "next-auth/react";
import { useWatchlist, type WatchlistItem } from "@/hooks/use-watchlist";
import { cn } from "@/lib/utils";

interface Props {
  item: WatchlistItem;
  variant?: "icon" | "full";
  className?: string;
  /**
   * Liquid Glass / Vision-style: barely visible idle, clear hover.
   * Used on home/poster cards (top-right).
   */
  glass?: boolean;
}

export function WatchlistButton({
  item,
  variant = "icon",
  className,
  glass = false,
}: Props) {
  const { data: session } = useSession();
  const { isIn, add, remove } = useWatchlist();
  const inList = isIn(item.tmdbId, item.mediaType);

  if (!session?.user?.id) {
    if (variant === "full") {
      return (
        <span title="Sign in to add to watchlist" className={cn("text-xs text-muted-foreground", className)}>
          Sign in to add to watchlist
        </span>
      );
    }
    return null;
  }

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inList) remove.mutate({ tmdbId: item.tmdbId, mediaType: item.mediaType });
    else add.mutate(item);
  };

  const pending = add.isPending || remove.isPending;

  if (variant === "full") {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold hover:bg-secondary/70 disabled:opacity-60",
          className
        )}
      >
        {inList ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {inList ? "In Watchlist" : "Add to Watchlist"}
      </button>
    );
  }

  if (glass) {
    // Liquid Glass: thin material, low contrast idle; hover = highlight only (no big scale).
    // Hit target 36px; looks smaller than the old solid black disc.
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full",
          // Glass material — only visible while hovering the card (group)
          "border border-white/[0.08] bg-white/[0.05] text-white/55",
          "shadow-[inset_0_0.5px_0_0_rgba(255,255,255,0.14)]",
          "backdrop-blur-md backdrop-saturate-125",
          "transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out",
          // Hidden until card hover / keyboard focus on card
          "pointer-events-none opacity-0",
          "group-hover:pointer-events-auto group-hover:opacity-100",
          "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          // Direct hover on the + itself
          "hover:scale-[1.04] hover:border-white/30 hover:bg-white/18 hover:text-white",
          "hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_0_0_0.5px_rgba(255,255,255,0.12)]",
          "active:scale-[0.97]",
          "focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          inList &&
            "border-white/15 bg-white/[0.1] text-white/90 hover:border-emerald-200/35 hover:bg-emerald-400/15 hover:text-emerald-50",
          pending && "pointer-events-none opacity-50",
          className
        )}
        title={inList ? "Remove from watchlist" : "Add to watchlist"}
        aria-label={
          inList ? `Remove ${item.title} from watchlist` : `Add ${item.title} to watchlist`
        }
      >
        {inList ? (
          <Check className="h-3.5 w-3.5 stroke-[2]" aria-hidden />
        ) : (
          <Plus className="h-3.5 w-3.5 stroke-[2]" aria-hidden />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className={cn(
        "rounded-full bg-black/70 p-2 text-white backdrop-blur hover:bg-black/90",
        className
      )}
      title={inList ? "Remove from watchlist" : "Add to watchlist"}
      aria-label={inList ? `Remove ${item.title} from watchlist` : `Add ${item.title} to watchlist`}
    >
      {inList ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
    </button>
  );
}
