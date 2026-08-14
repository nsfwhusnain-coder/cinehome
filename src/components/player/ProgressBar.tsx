"use client";

import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";

export interface ProgressBarProps {
  currentTime: number;
  duration: number;
  buffered: number;
  onSeek: (time: number) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Thin white seek bar — LordFlix anatomy:
 * #fff played, white/0.2 track, white/0.4 buffered;
 * 3px → 5px on hover; 12px white thumb on hover; timestamp tooltip.
 */
export function ProgressBar({
  currentTime,
  duration,
  buffered,
  onSeek,
}: ProgressBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [hoverRatio, setHoverRatio] = useState(0);
  const [dragging, setDragging] = useState(false);

  const safeDuration = duration > 0 && Number.isFinite(duration) ? duration : 0;
  const playedRatio = safeDuration > 0 ? clamp01(currentTime / safeDuration) : 0;
  const bufferedRatio = safeDuration > 0 ? clamp01(buffered / safeDuration) : 0;

  const ratioFromClientX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      if (safeDuration <= 0) return;
      onSeek(ratioFromClientX(clientX) * safeDuration);
    },
    [onSeek, ratioFromClientX, safeDuration]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const ratio = ratioFromClientX(e.clientX);
      setHoverRatio(ratio);
    },
    [ratioFromClientX]
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      setHovering(true);
      const ratio = ratioFromClientX(e.clientX);
      setHoverRatio(ratio);
    },
    [ratioFromClientX]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setHoverRatio(ratioFromClientX(e.clientX));
      setDragging(false);
      seekFromClientX(e.clientX);
    },
    [ratioFromClientX, seekFromClientX]
  );

  const onPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const showChrome = hovering || dragging;
  const tooltipRatio = showChrome ? hoverRatio : playedRatio;
  const thumbRatio = dragging ? hoverRatio : playedRatio;
  const tooltipTime = safeDuration * tooltipRatio;
  const barHeight = showChrome ? 5 : 3;
  const thumbSize = 12;

  return (
    <div
      ref={trackRef}
      className="group/progress relative flex w-full cursor-pointer items-center py-2.5"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={safeDuration || 0}
      aria-valuenow={Number.isFinite(currentTime) ? currentTime : 0}
      aria-valuetext={formatTime(currentTime)}
      tabIndex={0}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        if (!dragging) setHovering(false);
      }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        if (safeDuration <= 0) return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          onSeek(Math.min(safeDuration, currentTime + 5));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onSeek(Math.max(0, currentTime - 5));
        }
      }}
    >
      {/* Hover timestamp tooltip */}
      {showChrome && safeDuration > 0 && (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-2 -translate-x-1/2 rounded bg-black/90 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white shadow-md"
          style={{ left: `${tooltipRatio * 100}%` }}
        >
          {formatTime(tooltipTime)}
        </div>
      )}

      {/* Track */}
      <div
        className="relative w-full overflow-hidden rounded-full transition-[height] duration-150"
        style={{
          height: barHeight,
          backgroundColor: "rgba(255, 255, 255, 0.25)",
        }}
      >
        {/* Buffered */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${bufferedRatio * 100}%`,
            backgroundColor: "rgba(255, 255, 255, 0.4)",
          }}
        />
        {/* Played — pure white */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${playedRatio * 100}%`,
            backgroundColor: "#ffffff",
            transition: dragging ? "none" : "width 160ms linear",
          }}
        />
      </div>

      {/* Thumb — white, hidden unless hover/drag (never a teal accent) */}
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md transition-opacity duration-150",
          showChrome ? "opacity-100" : "opacity-0"
        )}
        style={{
          left: `${thumbRatio * 100}%`,
          width: thumbSize,
          height: thumbSize,
          backgroundColor: "#ffffff",
          border: "none",
          boxShadow: "none",
        }}
      />
    </div>
  );
}
