"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const GENERIC_SERVER_NAMES = new Set(["servers", "server", "source", "sources"]);

const STATUS_MESSAGES = [
  "Connecting…",
  "Resolving stream…",
  "Buffering…",
] as const;

const STATUS_ROTATE_MS = 2400;

/** The three real phases of getting a frame on screen, in order. */
const STAGES = ["Finding", "Connecting", "Buffering"] as const;

export interface LoadingScreenProps {
  backdropUrl?: string | null;
  /** Optional poster art; falls back to backdrop when omitted. */
  posterUrl?: string | null;
  serverName: string;
  title: string;
  visible: boolean;
  /** Optional explicit status; when set, rotation is disabled. */
  status?: string | null;
  /** Sources found so far (progressive discover). */
  sourceCount?: number;
  /** Still hunting more servers in the background. */
  discovering?: boolean;
}

/**
 * Full-bleed loading overlay: darkened backdrop, poster, title,
 * spinner + progress-aware status ("Finding sources… (3 found)").
 */
export function LoadingScreen({
  backdropUrl,
  posterUrl,
  serverName,
  title,
  visible,
  status,
  sourceCount = 0,
  discovering = false,
}: LoadingScreenProps) {
  const [statusIdx, setStatusIdx] = useState(0);

  const isGenericServer = useMemo(() => {
    const n = serverName.trim().toLowerCase();
    return !n || GENERIC_SERVER_NAMES.has(n);
  }, [serverName]);

  const statusPool = useMemo(() => {
    if (sourceCount > 0) {
      return [
        `Found ${sourceCount} source${sourceCount === 1 ? "" : "s"}…`,
        discovering
          ? `Found ${sourceCount} — searching for more…`
          : "Loading stream…",
        "Buffering…",
      ] as const;
    }
    if (isGenericServer) {
      return ["Finding sources…", "Searching for streams…", ...STATUS_MESSAGES] as const;
    }
    return [
      `Connecting to ${serverName}…`,
      "Resolving stream…",
      "Buffering…",
    ] as const;
  }, [isGenericServer, serverName, sourceCount, discovering]);

  /**
   * The rotation restarts from the first line whenever the screen (re)appears
   * or the pool changes. Doing that reset during render rather than in the
   * effect keeps the effect to what it is actually for — owning the interval —
   * and avoids briefly showing whichever line the previous playback attempt
   * happened to stop on.
   */
  const rotationKey = visible && !status ? `${statusPool.length}` : null;
  const [rotationFor, setRotationFor] = useState<string | null>(null);
  if (rotationKey !== rotationFor) {
    setRotationFor(rotationKey);
    setStatusIdx(0);
  }

  useEffect(() => {
    if (!visible || status) return;
    const id = window.setInterval(() => {
      setStatusIdx((v) => (v + 1) % statusPool.length);
    }, STATUS_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [visible, status, statusPool]);

  if (!visible) return null;

  const displayStatus = status?.trim() || statusPool[statusIdx % statusPool.length];
  const artUrl = posterUrl || backdropUrl || null;

  /**
   * Which of the three phases we are in, inferred from the status text the
   * player already computes (see `loadingStatus` in video-player.tsx) plus the
   * source count. Deliberately read-only: this reflects state that exists, it
   * does not fabricate a progress percentage nobody can measure.
   */
  const lower = displayStatus.toLowerCase();
  const stageIndex = /buffer/.test(lower)
    ? 2
    : /connect|preparing|resolv/.test(lower)
      ? 1
      : sourceCount > 0 && /choos|found/.test(lower)
        ? 1
        : 0;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center overflow-hidden bg-black"
      role="status"
      aria-live="polite"
      aria-label={displayStatus}
    >
      {backdropUrl ? (
         
        <img
          src={backdropUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full scale-105 object-cover"
          draggable={false}
        />
      ) : null}

      <div
        className={cn(
          "absolute inset-0",
          backdropUrl
            ? "bg-black/[0.85]"
            : "bg-gradient-to-b from-zinc-950 via-black to-zinc-950"
        )}
      />

      <div className="relative z-10 flex w-full max-w-md flex-col items-center px-6 text-center">
        {artUrl ? (
           
          <img
            src={artUrl}
            alt=""
            className="mb-5 h-36 w-24 rounded-lg object-cover shadow-2xl ring-1 ring-white/10 sm:h-44 sm:w-28"
            draggable={false}
          />
        ) : (
          <div className="mb-5 h-36 w-24 rounded-lg bg-white/5 ring-1 ring-white/10 sm:h-44 sm:w-28" />
        )}

        <p className="max-w-md truncate text-base font-semibold tracking-tight text-white sm:text-lg">
          {title}
        </p>

        <div className="mt-4 flex items-center gap-2.5 text-white/80">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/60" aria-hidden />
          <p className="text-sm font-medium tracking-wide">{displayStatus}</p>
        </div>

        {/*
          Stage rail. A single spinner cannot distinguish "still searching" from
          "connected, filling the buffer" — which fail differently and take very
          different amounts of time — so the three real phases are shown, with
          the current one lit and completed ones ticked. This is derived purely
          from props already passed in; it invents no progress it cannot see.
        */}
        <ol
          className="mt-5 flex w-full items-center justify-center gap-2 text-[11px] font-medium"
          aria-label="Loading progress"
        >
          {STAGES.map((label, i) => {
            const state = i < stageIndex ? "done" : i === stageIndex ? "active" : "todo";
            return (
              <li key={label} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    "h-1 w-full rounded-full transition-colors duration-500",
                    state === "done" && "bg-white/55",
                    state === "active" && "bg-white/85",
                    state === "todo" && "bg-white/12"
                  )}
                />
                <span
                  className={cn(
                    "whitespace-nowrap transition-colors duration-500",
                    state === "done" && "text-white/45",
                    state === "active" && "text-white/85",
                    state === "todo" && "text-white/25"
                  )}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>

        {sourceCount > 0 && (
          <p className="mt-3 text-[11px] tracking-wide text-white/40">
            {sourceCount} source{sourceCount === 1 ? "" : "s"} found
            {discovering ? " · still looking for more" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
