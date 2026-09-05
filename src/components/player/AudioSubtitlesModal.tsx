"use client";

import { useState, useMemo, useEffect, type CSSProperties } from "react";
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

const GLASS_STYLE: CSSProperties = {
  background: "rgba(18, 18, 22, 0.65)",
  WebkitBackdropFilter: "blur(32px) saturate(180%) brightness(1.12)",
  backdropFilter: "blur(32px) saturate(180%) brightness(1.12)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.5)",
};

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
  const [activeTab, setActiveTab] = useState<"subtitles" | "audio" | "sync">("subtitles");
  const [subSearch, setSubSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const filteredSubtitles = useMemo(() => {
    if (!subSearch.trim()) return subtitleTracks;
    const q = subSearch.toLowerCase();
    return subtitleTracks.filter(
      (t) =>
        t.label?.toLowerCase().includes(q) ||
        t.name?.toLowerCase().includes(q) ||
        t.language?.toLowerCase().includes(q) ||
        t.lang?.toLowerCase().includes(q)
    );
  }, [subtitleTracks, subSearch]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Compact Apple Glass Modal Card */}
      <div
        className="relative z-10 flex flex-col h-full max-h-[min(70vh,520px)] w-full max-w-md overflow-hidden rounded-2xl border border-white/20 shadow-2xl animate-in zoom-in-95 duration-200"
        style={GLASS_STYLE}
      >
        {/* Specular border edge */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{
            padding: 1,
            background:
              "linear-gradient(160deg, rgba(255,255,255,0.48) 0%, rgba(255,255,255,0.06) 42%, rgba(255,255,255,0.16) 100%)",
            WebkitMask:
              "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            WebkitMaskComposite: "xor",
            mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            maskComposite: "exclude",
          }}
        />

        <div className="relative z-[1] flex flex-col min-h-0 flex-1">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Audio & Subtitles</h2>
              <p className="text-[11px] text-zinc-400">Manage tracks, sync, and display</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Segmented Tab Selector */}
          <div className="flex items-center gap-1 border-b border-white/10 px-3 py-2 bg-white/5">
            <button
              type="button"
              onClick={() => setActiveTab("subtitles")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-medium transition",
                activeTab === "subtitles"
                  ? "bg-white text-black font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              )}
            >
              <Subtitles className="h-3.5 w-3.5" />
              <span>Subtitles ({subtitleTracks.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("audio")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-medium transition",
                activeTab === "audio"
                  ? "bg-white text-black font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              )}
            >
              <Volume2 className="h-3.5 w-3.5" />
              <span>Audio ({audioTracks.length || 1})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("sync")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-medium transition",
                activeTab === "sync"
                  ? "bg-white text-black font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              )}
            >
              <Sliders className="h-3.5 w-3.5" />
              <span>Sync & Font</span>
            </button>
          </div>

          {/* Tab Body */}
          <div className="flex-1 overflow-y-auto p-3 min-h-0">
            {activeTab === "subtitles" && (
              <div className="flex flex-col h-full space-y-2">
                {subtitleTracks.length > 4 && (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                    <input
                      type="text"
                      placeholder="Search language..."
                      value={subSearch}
                      onChange={(e) => setSubSearch(e.target.value)}
                      className="w-full rounded-xl bg-white/10 border border-white/15 pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-white/40"
                    />
                  </div>
                )}

                <div className="space-y-1 overflow-y-auto flex-1 pr-0.5">
                  <button
                    type="button"
                    onClick={() => onSelectSubtitle?.(null)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium transition",
                      activeSubtitleId === null
                        ? "bg-white/20 border border-white/30 text-white shadow-sm"
                        : "hover:bg-white/10 text-zinc-300 border border-transparent"
                    )}
                  >
                    <span>Off</span>
                    {activeSubtitleId === null && <Check className="h-3.5 w-3.5 text-white" />}
                  </button>

                  {filteredSubtitles.map((track) => {
                    const isSelected = activeSubtitleId === track.id;
                    return (
                      <button
                        key={track.id}
                        type="button"
                        onClick={() => onSelectSubtitle?.(track.id)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium transition",
                          isSelected
                            ? "bg-white/20 border border-white/30 text-white shadow-sm"
                            : "hover:bg-white/10 text-zinc-300 border border-transparent"
                        )}
                      >
                        <span className="truncate pr-2">{track.label || track.name || `Track ${track.id}`}</span>
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-white" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === "audio" && (
              <div className="space-y-1 overflow-y-auto flex-1">
                {audioTracks.length === 0 ? (
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-xl bg-white/20 border border-white/30 px-3 py-2 text-left text-xs font-medium text-white shadow-sm"
                  >
                    <span>Default Audio</span>
                    <Check className="h-3.5 w-3.5 text-white" />
                  </button>
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
                          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium transition",
                          isSelected
                            ? "bg-white/20 border border-white/30 text-white shadow-sm"
                            : "hover:bg-white/10 text-zinc-300 border border-transparent"
                        )}
                      >
                        <span className="truncate pr-2">
                          {track.label || track.name || `Track ${trackId + 1}`}
                        </span>
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-white" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {activeTab === "sync" && (
              <div className="space-y-4 py-2 px-1">
                {/* Subtitle Sync Steppers */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-zinc-200">Subtitle Sync:</span>
                    <span className="text-xs font-mono font-bold tabular-nums text-white bg-white/15 px-2 py-0.5 rounded-md">
                      {subtitleOffset > 0 ? `+${subtitleOffset.toFixed(2)}s` : `${subtitleOffset.toFixed(2)}s`}
                    </span>
                  </div>

                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset - 0.5).toFixed(2)))}
                      className="flex-1 rounded-lg bg-white/10 py-1.5 text-xs font-medium text-white hover:bg-white/20 transition"
                    >
                      -0.5s
                    </button>
                    <button
                      type="button"
                      onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset - 0.1).toFixed(2)))}
                      className="flex-1 rounded-lg bg-white/10 py-1.5 text-xs font-medium text-white hover:bg-white/20 transition"
                    >
                      -0.1s
                    </button>
                    <button
                      type="button"
                      onClick={() => onSubtitleOffsetChange?.(0)}
                      title="Reset offset"
                      className="flex items-center justify-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/20 transition"
                    >
                      <RotateCcw className="h-3 w-3" /> Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset + 0.1).toFixed(2)))}
                      className="flex-1 rounded-lg bg-white/10 py-1.5 text-xs font-medium text-white hover:bg-white/20 transition"
                    >
                      +0.1s
                    </button>
                    <button
                      type="button"
                      onClick={() => onSubtitleOffsetChange?.(Number((subtitleOffset + 0.5).toFixed(2)))}
                      className="flex-1 rounded-lg bg-white/10 py-1.5 text-xs font-medium text-white hover:bg-white/20 transition"
                    >
                      +0.5s
                    </button>
                  </div>
                </div>

                {/* Subtitle Font Size */}
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200 mb-2">
                    <Type className="h-3.5 w-3.5 text-white" />
                    <span>Subtitle Font Size:</span>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 bg-black/30 p-1.5 rounded-xl border border-white/10">
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
                          "rounded-lg px-2.5 py-1.5 text-xs font-medium transition text-center",
                          subtitleFontSize === val
                            ? "bg-white text-black font-semibold shadow-sm"
                            : "text-zinc-400 hover:text-white"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
