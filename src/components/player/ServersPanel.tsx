"use client";

import { Fragment, useEffect, useState } from "react";
import { Cloud, Crown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";
import { formatResolutionLabel, type SourceHealthState } from "@/lib/playback/source-quality";
import { STABLE_SERVER_CAP } from "@/lib/playback/server-theme";

export interface ServerItem {
  id: string;
  /** Greek-themed name ONLY — never includes quality/resolution (that's `qualityLabel` below + the separate Quality control). */
  name: string;
  flag: string;
  active: boolean;
  /** Hard runtime failure this session — greyed + sorted last, but NEVER removed or made unclickable (manual retry stays available). */
  failed?: boolean;
  /**
   * Honest health of a non-active source: "healthy" (probed reachable),
   * "checking" (background probe still pending/unproven), or "weak"
   * (soft-kept / failed probe). Never drives auto-selection — only the dot
   * + sort position the caller already applied. Defaults to "checking" so
   * callers that don't pass it get the pre-existing neutral dot.
   */
  health?: SourceHealthState;
  /** origin === "debrid" — Real-Debrid/TorBox premium tier, marked distinctly (gold crown). */
  premium?: boolean;
  /**
   * False when THIS browser can't play this release natively (HEVC/AV1 it
   * can't decode, or any MKV/WebM container) — it plays via /api/transcode
   * instead. Never hides the row — still selectable per the product rule
   * ("selectable, not auto-picked") — only groups/sorts it honestly below
   * what actually plays here natively. Undefined/true = plays here.
   */
  playableHere?: boolean;
  /** Best-known resolution height, for quality-tier grouping (4K/1080p/…). */
  height?: number;
  /** Small per-row resolution badge text (e.g. "4K", "1080p · transcode") — the
   * quality-per-server-at-a-glance marker; name itself stays quality-free. */
  qualityLabel?: string;
}

/** Group header text for a row — resolution tier for playable rows, or an
 * honest reason it's sorted below (never a silent, unlabeled reordering).
 * `playableHere === false` no longer means unusable — it plays via the
 * in-container transcoder (a short startup delay), so the header must say
 * that rather than the old (now false) "Not available in this browser". */
function sectionLabelFor(server: ServerItem): string {
  if (server.failed) return "Unavailable";
  if (server.playableHere === false) return "Plays via transcode";
  return formatResolutionLabel(server.height ?? 0);
}

const HEALTH_DOT_CLASS: Record<SourceHealthState, string> = {
  healthy: "bg-emerald-500/70",
  checking: "bg-zinc-400 animate-pulse",
  weak: "bg-amber-500/80",
};

export interface ServersPanelProps {
  servers: ServerItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  open: boolean;
}

const GLASS_PANEL: CSSProperties = {
  background: "rgba(18, 18, 22, 0.42)",
  WebkitBackdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  backdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.45)",
};

/**
 * Floating servers panel — glass material matching player settings dock.
 *
 * STABILITY: unlike the old "re-cap to the top on every reopen" behavior,
 * `expanded` is plain component state that lives for as long as the player
 * is mounted — closing/reopening the panel (`open` toggling) no longer
 * resets it. Combined with `player-controls.tsx` freezing each source's
 * row position the first time it's seen, switching servers or a background
 * probe finishing never reshuffles or hides a row the owner has already
 * looked at.
 */
export function ServersPanel({
  servers,
  onSelect,
  onClose,
  open,
}: ServersPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // Esc closes — Tab/Enter navigation is native <button> behavior already.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Healthy + honest: excludes hard-failed, soft-kept/probe-failed, AND
  // anything this browser can't decode — "N sources" should mean N the owner
  // can actually watch right now, not just N that merely probed reachable.
  const healthyCount = servers.filter(
    (s) => !s.failed && s.health !== "weak" && s.playableHere !== false
  ).length;

  const visibleServers = expanded ? servers : servers.slice(0, STABLE_SERVER_CAP);
  const hiddenCount = servers.length - visibleServers.length;
  // Precomputed (not a running mutable var) so each row can tell whether it
  // starts a new section by comparing against the previous entry by index.
  const sectionLabels = visibleServers.map(sectionLabelFor);

  return (
    <div
      className="absolute bottom-16 right-3 z-40 w-[min(100%-1.5rem,280px)] overflow-hidden rounded-[1.25rem] border border-white/20 sm:right-4"
      style={GLASS_PANEL}
      role="dialog"
      aria-label="Servers"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/12 px-3.5 py-2.5">
        <Cloud className="h-4 w-4 shrink-0 text-white/80" strokeWidth={1.75} />
        <h2 className="flex-1 text-[13px] font-semibold tracking-wide text-white">
          Servers{servers.length > 0 ? ` · ${healthyCount}` : ""}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition hover:bg-white/15 hover:text-white"
          aria-label="Close servers"
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {/* List — grouped by honest section (resolution tier, then "not
          available in this browser", then failed), capped to keep a 30-40
          source roster scannable; caller already sorted this order. */}
      <ul className="max-h-[min(50vh,320px)] space-y-0.5 overflow-y-auto p-1.5">
        {servers.length === 0 && (
          <li className="px-3 py-4 text-center text-[12px] text-white/45">
            No servers available
          </li>
        )}
        {visibleServers.map((server, idx) => {
          const muted = !!server.failed || server.health === "weak" || server.playableHere === false;
          const dotClass = server.active
            ? "bg-emerald-400"
            : server.failed
              ? "bg-zinc-500"
              : HEALTH_DOT_CLASS[server.health ?? "checking"];
          const section = sectionLabels[idx];
          const showDivider = idx === 0 || section !== sectionLabels[idx - 1];
          return (
            <Fragment key={server.id}>
              {showDivider && (
                <li
                  aria-hidden
                  className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-white/35 first:pt-0.5"
                >
                  {section}
                </li>
              )}
              <li>
                <button
                  type="button"
                  onClick={() => onSelect(server.id)}
                  aria-label={
                    server.failed ? `${server.name} — unavailable, tap to retry` : server.name
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[13px] transition-colors",
                    !server.active && "border-transparent hover:border-white/10 hover:bg-white/[0.08]",
                    server.active
                      ? "border-white/20 bg-white/15 font-medium text-white"
                      : muted
                        ? "text-white/45"
                        : "text-white/75",
                    server.failed && "opacity-60"
                  )}
                >
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)}
                    aria-hidden
                  />
                  {server.flag && (
                    <span className="shrink-0 text-[15px] leading-none" aria-hidden>
                      {server.flag}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{server.name}</span>
                  {server.premium && (
                    <Crown
                      className="h-3 w-3 shrink-0 text-amber-400"
                      aria-label="Premium (Real-Debrid)"
                    />
                  )}
                  {server.qualityLabel && (
                    <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/55">
                      {server.qualityLabel}
                    </span>
                  )}
                  {server.active && (
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-emerald-400/90">
                      Live
                    </span>
                  )}
                </button>
              </li>
            </Fragment>
          );
        })}
        {hiddenCount > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full rounded-xl px-2.5 py-2 text-center text-[12px] font-medium text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white/80"
            >
              Show {hiddenCount} more server{hiddenCount === 1 ? "" : "s"}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
