"use client";

import { useState, useMemo } from "react";
import {
  X,
  Check,
  Search,
  Volume2,
  Subtitles,
  Sliders,
  Type,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface AudioSubtitlesModalProps {
  open: boolean;
  onClose: () => void;
  audioTracks?: Array<{
    id: number;
    label?: string;
    name?: string;
    language?: string;
    lang?: string;
  }>;
  activeAudioTrackId?: number | null;
  onSelectAudioTrack?: (id: number) => void;
  subtitleTracks?: Array<{
    id: string;
    label?: string;
    name?: string;
    language?: string;
    lang?: string;
  }>;
  activeSubtitleId?: string | null;
  onSelectSubtitle?: (id: string | null) => void;
  subtitleOffset?: number; // in seconds
  onSubtitleOffsetChange?: (offset: number) => void;
  subtitleFontSize?: "small" | "medium" | "large" | "extra-large";
  onSubtitleFontSizeChange?: (size: "small" | "medium" | "large" | "extra-large") => void;
}

export function AudioSubtitlesModal({
  open,
  onClose,
  audioTracks = [],
  activeAudioTrackId = null,
  onSelectAudioTrack,
  subtitleTracks = [],
  activeSubtitleId = null,
  onSelectSubtitle,
  subtitleOffset = 0,
  onSubtitleOffsetChange,
  subtitleFontSize = "medium",
  onSubtitleFontSizeChange,
}: AudioSubtitlesModalProps) {
  const [subSearch, setSubSearch] = useState("");

  const filteredSubtitles = useMemo(() => {
    if (!subSearch.trim()) return subtitleTracks;
    const q = subSearch.toLowerCase();
    return subtitleTracks.filter(
      (s) =>
        (s.label || s.name || "").toLowerCase().includes(q) ||
        ((s.language || s.lang) && (s.language || s.lang || "").toLowerCase().includes(q))
    );
  }, [subtitleTracks, subSearch]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md"
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative z-10 flex flex-col h-full max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-zinc-950/95 border border-white/15 shadow-2xl backdrop-blur-2xl animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white">
              <Sliders className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Audio & Subtitles</h2>
              <p className="text-xs text-zinc-400">Configure language, sync, and subtitle appearance</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Dual Columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 flex-1 min-h-0 divide-y md:divide-y-0 md:divide-x divide-white/10">
          {/* Audio Tracks Column */}
          <div className="flex flex-col min-h-0 p-5 overflow-hidden">
            <div className="flex items-center gap-2 mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              <Volume2 className="h-4 w-4 text-white" />
              <span>Audio Tracks ({audioTracks.length || 1})</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {audioTracks.length === 0 ? (
                <div className="flex items-center justify-between rounded-xl border border-white/25 bg-white/15 px-4 py-3 text-sm font-medium text-white">
                  <span>Default Audio</span>
                  <Check className="h-4 w-4 text-white" />
                </div>
              ) : (
                audioTracks.map((track, i) => {
                  const trackId = typeof track.id === "number" ? track.id : i;
                  const isSelected = activeAudioTrackId === trackId;
                  return (
                    <button
                      key={trackId}
                      type="button"
                      onClick={() => onSelectAudioTrack?.(trackId)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-medium transition-all duration-150",
                        isSelected
                          ? "border-white/40 bg-white/15 text-white shadow"
                          : "border-white/5 bg-zinc-900/60 text-zinc-300 hover:border-white/20 hover:bg-zinc-800/80"
                      )}
                    >
                      <span className="truncate pr-2">{(track.label || track.name || `Track ${track.id + 1}`) || `Track ${trackId + 1}`}</span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-white" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Subtitles Column */}
          <div className="flex flex-col min-h-0 p-5 overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Subtitles className="h-4 w-4 text-white" />
                <span>Subtitles ({subtitleTracks.length})</span>
              </div>
            </div>

            {/* Subtitle Search Bar */}
            {subtitleTracks.length > 5 && (
              <div className="relative mb-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search language..."
                  value={subSearch}
                  onChange={(e) => setSubSearch(e.target.value)}
                  className="w-full rounded-lg bg-zinc-900 border border-white/10 pl-9 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                />
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {/* Off Option */}
              <button
                type="button"
                onClick={() => onSelectSubtitle?.(null)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-all duration-150",
                  activeSubtitleId === null
                    ? "border-white/40 bg-white/15 text-white shadow"
                    : "border-white/5 bg-zinc-900/60 text-zinc-300 hover:border-white/20 hover:bg-zinc-800/80"
                )}
              >
                <span>Off</span>
                {activeSubtitleId === null && <Check className="h-4 w-4 text-white" />}
              </button>

              {filteredSubtitles.map((track) => {
                const isSelected = activeSubtitleId === track.id;
                return (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => onSelectSubtitle?.(track.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-all duration-150",
                      isSelected
                        ? "border-white/40 bg-white/15 text-white shadow"
                        : "border-white/5 bg-zinc-900/60 text-zinc-300 hover:border-white/20 hover:bg-zinc-800/80"
                    )}
                  >
                    <span className="truncate pr-2">{(track.label || track.name || `Track ${track.id + 1}`)}</span>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-white" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Subtitle Sync & Customization Footer */}
        <div className="border-t border-white/10 bg-zinc-900/80 px-6 py-4 space-y-3.5">
          {/* Subtitle Sync Offset */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-300">Subtitle Sync Offset:</span>
              <span className="text-xs font-mono font-bold tabular-nums text-white bg-white/10 px-2 py-0.5 rounded">
                {subtitleOffset > 0 ? `+${subtitleOffset.toFixed(2)}s` : `${subtitleOffset.toFixed(2)}s`}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset - 0.5).toFixed(2)))}
                className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20 transition"
              >
                -0.5s
              </button>
              <button
                type="button"
                onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset - 0.1).toFixed(2)))}
                className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20 transition"
              >
                -0.1s
              </button>
              <button
                type="button"
                onClick={() => onSubtitleOffsetChange?.(0)}
                title="Reset offset"
                className="flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-white/20 transition"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
              <button
                type="button"
                onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset + 0.1).toFixed(2)))}
                className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20 transition"
              >
                +0.1s
              </button>
              <button
                type="button"
                onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset + 0.5).toFixed(2)))}
                className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20 transition"
              >
                +0.5s
              </button>
            </div>
          </div>

          {/* Subtitle Font Size Presets */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-white/5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
              <Type className="h-3.5 w-3.5 text-white" />
              <span>Subtitle Size:</span>
            </div>

            <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/10">
              {(
                [
                  ["small", "Small (75%)"],
                  ["medium", "Normal (100%)"],
                  ["large", "Large (125%)"],
                  ["extra-large", "XL (150%)"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => onSubtitleFontSizeChange?.(val)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                    subtitleFontSize === val
                      ? "bg-white text-black font-semibold shadow"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
