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

  useEffect(() => {
    if (!visible || status) return;
    setStatusIdx(0);
    const id = window.setInterval(() => {
      setStatusIdx((v) => (v + 1) % statusPool.length);
    }, STATUS_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [visible, status, statusPool]);

  if (!visible) return null;

  const displayStatus = status?.trim() || statusPool[statusIdx % statusPool.length];
  const artUrl = posterUrl || backdropUrl || null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center overflow-hidden bg-black"
      role="status"
      aria-live="polite"
      aria-label={displayStatus}
    >
      {backdropUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
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

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        {artUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
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

        <div className="mt-4 flex items-center gap-2.5 text-white/70">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/55" aria-hidden />
          <p className="text-sm tracking-wide">{displayStatus}</p>
        </div>
      </div>
    </div>
  );
}
