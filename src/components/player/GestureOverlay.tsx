"use client";

import { useEffect, useState } from "react";
import {
  Sun,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface GestureOverlayProps {
  ripple: { side: "left" | "right"; count: number } | null;
  brightness: number | null; // 0.3 to 1.5
  volume: number | null; // 0 to 1
  isMuted?: boolean;
}

export function GestureOverlay({
  ripple,
  brightness,
  volume,
  isMuted = false,
}: GestureOverlayProps) {
  const [activeRipple, setActiveRipple] = useState<{
    side: "left" | "right";
    count: number;
    key: number;
  } | null>(null);

  useEffect(() => {
    if (!ripple) return;
    setActiveRipple({ ...ripple, key: Date.now() });
    const timer = setTimeout(() => setActiveRipple(null), 650);
    return () => clearTimeout(timer);
  }, [ripple]);

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden select-none">
      {/* Seek Ripples (Left & Right Double-Tap) */}
      {activeRipple && (
        <div
          key={activeRipple.key}
          className={cn(
            "absolute top-0 bottom-0 flex w-[40%] items-center justify-center transition-all duration-300",
            activeRipple.side === "left"
              ? "left-0 bg-gradient-to-r from-white/15 to-transparent rounded-r-[100%]"
              : "right-0 bg-gradient-to-l from-white/15 to-transparent rounded-l-[100%]"
          )}
        >
          <div className="flex flex-col items-center gap-1.5 animate-in zoom-in-75 duration-200">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/20 backdrop-blur-md shadow-lg border border-white/20 text-white">
              {activeRipple.side === "left" ? (
                <RotateCcw className="h-7 w-7 animate-pulse" />
              ) : (
                <RotateCw className="h-7 w-7 animate-pulse" />
              )}
            </div>
            <div className="rounded-full bg-black/70 px-3 py-1 text-xs font-bold tracking-wide text-white shadow backdrop-blur-sm">
              {activeRipple.side === "left"
                ? `-${activeRipple.count * 10}s`
                : `+${activeRipple.count * 10}s`}
            </div>
          </div>
        </div>
      )}

      {/* Brightness HUD (Top-Center) */}
      {brightness != null && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-white shadow-2xl border border-white/15 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
          <Sun className="h-4 w-4 text-amber-400" />
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full bg-amber-400 transition-all duration-75 rounded-full"
              style={{
                width: `${Math.min(100, Math.max(0, ((brightness - 0.3) / 1.2) * 100))}%`,
              }}
            />
          </div>
          <span className="text-xs font-mono font-semibold tabular-nums">
            {Math.round(((brightness - 0.3) / 1.2) * 100)}%
          </span>
        </div>
      )}

      {/* Volume HUD (Top-Center) */}
      {volume != null && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-white shadow-2xl border border-white/15 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
          {isMuted || volume === 0 ? (
            <VolumeX className="h-4 w-4 text-red-400" />
          ) : (
            <Volume2 className="h-4 w-4 text-white" />
          )}
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full bg-white transition-all duration-75 rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, volume * 100))}%` }}
            />
          </div>
          <span className="text-xs font-mono font-semibold tabular-nums">
            {isMuted ? "0%" : `${Math.round(volume * 100)}%`}
          </span>
        </div>
      )}
    </div>
  );
}
