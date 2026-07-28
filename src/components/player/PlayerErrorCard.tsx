"use client";

import { useEffect, useRef } from "react";
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred =
        dialog?.querySelector<HTMLElement>("[data-error-primary='true']") ??
        dialog?.querySelector<HTMLElement>("button");
      preferred?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape" && onDismiss) {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.shiftKey ? -1 : 1;
    const next =
      current < 0 ? 0 : (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      ref={dialogRef}
      className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center backdrop-blur-[2px]"
      role="alertdialog"
      data-player-error
      aria-modal="true"
      aria-label={headline}
      aria-live="assertive"
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-3 top-3 min-h-11 min-w-11 rounded-full p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
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
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              data-error-primary={
                action.variant !== "secondary" && index === 0 ? "true" : undefined
              }
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-medium transition",
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
