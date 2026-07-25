"use client";

import { AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PlayerErrorAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  /** "primary" (default) = filled accent pill. "secondary" = quiet glass pill. */
  variant?: "primary" | "secondary";
}

export interface PlayerErrorCardProps {
  /** Short, specific statement of what's wrong — never a raw stack/code. */
  headline: string;
  /** One honest sentence of context or next-step framing. */
  subtext?: string | null;
  actions?: PlayerErrorAction[];
  /** Omit to hide the corner dismiss — used for unrecoverable-without-action states (exhaustion). */
  onDismiss?: () => void;
}

/**
 * Clean, centered terminal-state card — replaces the old small top-left
 * banner for anything the player can't recover from on its own (all sources
 * exhausted, parent fetch failed, browser can't decode the stream). Always
 * gives the owner a concrete next step (never a dead end / cryptic message).
 */
export function PlayerErrorCard({ headline, subtext, actions = [], onDismiss }: PlayerErrorCardProps) {
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center backdrop-blur-[2px]"
      role="alert"
      aria-live="assertive"
    >
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-3 top-3 rounded-full p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <AlertCircle className="h-9 w-9 shrink-0 text-amber-400" aria-hidden />
      <p className="max-w-sm text-[15px] font-semibold leading-snug text-white">{headline}</p>
      {subtext && (
        <p className="max-w-sm text-[13px] leading-relaxed text-white/60">{subtext}</p>
      )}
      {actions.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium transition",
                action.variant === "secondary"
                  ? "bg-white/10 text-white hover:bg-white/20"
                  : "bg-primary/90 text-primary-foreground hover:bg-primary"
              )}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
