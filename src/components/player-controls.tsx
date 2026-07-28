"use client";

import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Captions,
  RotateCcw,
  RotateCw,
  Cloud,
  ArrowLeft,
  PictureInPicture2,
  SkipForward as NextEpisodeIcon,
  ListVideo,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player-store";
import type { PlaybackSource } from "@/lib/playback/types";
import { PlayerDock, type DockSection } from "@/components/player-dock";
import { ProgressBar } from "@/components/player/ProgressBar";
import {
  EpisodesPanel,
  type SeasonOption,
} from "@/components/player/EpisodesPanel";
import type {
  PlayerQualityOption,
  PlayerQualityTarget,
} from "@/lib/playback/quality-router";
import { useEffect, useRef, useState } from "react";

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Seek10Icon({ direction }: { direction: "back" | "forward" }) {
  const Icon = direction === "back" ? RotateCcw : RotateCw;
  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center">
      <Icon className="h-5 w-5" strokeWidth={1.75} />
      <span className="pointer-events-none absolute text-[7px] font-bold leading-none text-current">
        10
      </span>
    </span>
  );
}

interface Props {
  title: string;
  mediaType?: "movie" | "tv";
  sources: PlaybackSource[];
  activeSourceId: string;
  onSourceChange: (source: PlaybackSource) => void;
  onTogglePlay: () => void;
  onSeekRelative: (seconds: number) => void;
  onSeekTo: (time: number) => void;
  onToggleMute: () => void;
  onSetVolume: (v: number) => void;
  onToggleFullscreen: () => void;
  onTogglePip: () => void;
  onToggleSettings?: (section?: DockSection) => void;
  settingsOpen?: boolean;
  onToggleShortcuts?: () => void;
  shortcutsOpen?: boolean;
  dockSection: DockSection | null;
  onDockSectionChange: (section: DockSection | null) => void;
  onCloseDock: () => void;
  qualityTargets: PlayerQualityOption[];
  activeQualityTarget: PlayerQualityTarget;
  onQualityTargetChange: (target: PlayerQualityTarget) => void;
  onSubtitleChange: (trackId: number | null) => void;
  onAudioChange: (trackId: number) => void;
  onSetSpeed: (speed: number) => void;
  hasNextEpisode?: boolean;
  onNextEpisode?: () => void;
  alwaysShowControls?: boolean;
  isDiscoveringSources?: boolean;
  failedSourceIds?: string[];
  onBack?: () => void;
  /** TV episode picker */
  tvId?: number;
  tvSeasons?: SeasonOption[];
  tvSeason?: number;
  tvEpisode?: number;
  onSelectEpisode?: (season: number, episode: number) => void;
  sleepMinutes?: number | null;
  onSleepMinutesChange?: (minutes: number | null) => void;
}

export function PlayerControls({
  title,
  mediaType,
  sources,
  activeSourceId,
  onSourceChange,
  onTogglePlay,
  onSeekRelative,
  onSeekTo,
  onToggleMute,
  onSetVolume,
  onToggleFullscreen,
  onTogglePip,
  onToggleSettings,
  settingsOpen,
  onToggleShortcuts,
  shortcutsOpen,
  dockSection,
  onDockSectionChange,
  onCloseDock,
  qualityTargets,
  activeQualityTarget,
  onQualityTargetChange,
  onSubtitleChange,
  onAudioChange,
  onSetSpeed,
  hasNextEpisode,
  onNextEpisode,
  alwaysShowControls,
  isDiscoveringSources,
  failedSourceIds = [],
  onBack,
  tvId,
  tvSeasons = [],
  tvSeason,
  tvEpisode,
  onSelectEpisode,
  sleepMinutes = null,
  onSleepMinutesChange,
}: Props) {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const showControls = usePlayerStore((s) => s.showControls);
  // Buffered edge lives in the store (not a VideoPlayer-level re-render prop) —
  // isolates the ~4x/sec update to this subtree instead of the 2,360-line parent.
  const buffered = usePlayerStore((s) => s.bufferedEnd);

  const [showEpisodes, setShowEpisodes] = useState(false);
  const [supportsFullscreen, setSupportsFullscreen] = useState(false);
  const [supportsPip, setSupportsPip] = useState(false);
  const shortcutsDialogRef = useRef<HTMLDivElement>(null);
  const shortcutsPreviousFocusRef = useRef<HTMLElement | null>(null);

  const showTvEpisodes =
    mediaType === "tv" &&
    typeof tvId === "number" &&
    typeof tvSeason === "number" &&
    typeof tvEpisode === "number" &&
    !!onSelectEpisode;

  const controlsVisible =
    showControls || alwaysShowControls || !!settingsOpen || showEpisodes;

  useEffect(() => {
    setSupportsFullscreen(
      typeof document.documentElement.requestFullscreen === "function"
    );
    setSupportsPip(
      document.pictureInPictureEnabled === true &&
        typeof HTMLVideoElement.prototype.requestPictureInPicture === "function"
    );
  }, []);

  useEffect(() => {
    if (!shortcutsOpen) return;
    shortcutsPreviousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      shortcutsDialogRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      shortcutsPreviousFocusRef.current?.focus();
      shortcutsPreviousFocusRef.current = null;
    };
  }, [shortcutsOpen]);

  const showNextEpisode = mediaType === "tv" && !!hasNextEpisode;
  return (
    <>
      {/* Top bar — LordFlix */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-between px-4 transition-opacity duration-300 sm:px-5",
          "bg-gradient-to-b from-black/75 to-transparent",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex h-11 w-11 items-center justify-center text-white transition hover:opacity-70"
          aria-label="Back"
        >
          <ArrowLeft className="h-7 w-7" strokeWidth={1.5} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[15px] font-medium text-white">
          {title}
        </div>
        <span className="h-11 w-11 shrink-0" aria-hidden />
      </div>

      {/* Settings dock (quality/speed) */}
      <PlayerDock
        open={!!settingsOpen}
        onClose={onCloseDock}
        expandedSection={dockSection}
        onExpandedSectionChange={onDockSectionChange}
        sources={sources}
        activeSourceId={activeSourceId}
        onSourceChange={onSourceChange}
        qualityTargets={qualityTargets}
        activeQualityTarget={activeQualityTarget}
        onQualityTargetChange={onQualityTargetChange}
        onSubtitleChange={onSubtitleChange}
        onAudioChange={onAudioChange}
        onSetSpeed={onSetSpeed}
        isDiscoveringSources={isDiscoveringSources}
        failedSourceIds={failedSourceIds}
        sleepMinutes={sleepMinutes}
        onSleepMinutesChange={onSleepMinutesChange}
        onOpenShortcuts={() => {
          onCloseDock();
          onToggleShortcuts?.();
        }}
      />

      {showTvEpisodes ? (
        <EpisodesPanel
          open={showEpisodes}
          tvId={tvId}
          seasons={tvSeasons}
          season={tvSeason}
          episode={tvEpisode}
          onClose={() => setShowEpisodes(false)}
          onSelect={onSelectEpisode}
        />
      ) : null}

      {/* Bottom strip: full-bleed progress flush above icon row (LordFlix) */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 pt-14 transition-opacity duration-300",
          "bg-gradient-to-t from-black/80 via-black/40 to-transparent",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Full viewport width — zero side padding */}
        <div className="w-full px-0">
          <ProgressBar
            currentTime={currentTime}
            duration={duration || 0}
            buffered={buffered}
            onSeek={onSeekTo}
          />
        </div>

        <div className="flex items-center gap-1 px-3 pb-3 pt-0.5 sm:gap-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <IconBtn onClick={onTogglePlay} label={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? (
                <Pause className="h-5 w-5 fill-current" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
            </IconBtn>
            <IconBtn onClick={() => onSeekRelative(-10)} label="Back 10s">
              <Seek10Icon direction="back" />
            </IconBtn>
            <IconBtn onClick={() => onSeekRelative(10)} label="Forward 10s">
              <Seek10Icon direction="forward" />
            </IconBtn>
            <div className="flex items-center gap-1.5">
              <IconBtn onClick={onToggleMute} label="Mute">
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-5 w-5" />
                ) : (
                  <Volume2 className="h-5 w-5" />
                )}
              </IconBtn>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => onSetVolume(Number(e.target.value))}
                className="hidden h-1 w-16 cursor-pointer appearance-none bg-transparent sm:block
                  [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-white/30
                  [&::-webkit-slider-thumb]:-mt-[3px] [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
                  [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/30
                  [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
                aria-label="Volume"
              />
            </div>
            <div className="ml-1 hidden whitespace-nowrap text-[13px] tabular-nums text-white sm:block">
              {formatTime(currentTime)}
              <span className="text-white/50"> / </span>
              <span className="text-white/80">{formatTime(duration)}</span>
            </div>
            {showNextEpisode && (
              <IconBtn onClick={onNextEpisode} label="Next episode">
                <NextEpisodeIcon className="h-5 w-5" />
              </IconBtn>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            {showTvEpisodes ? (
              <IconBtn
                onClick={() => {
                  onCloseDock();
                  setShowEpisodes((v) => !v);
                }}
                label="Episodes"
                active={showEpisodes}
              >
                <ListVideo className="h-5 w-5" />
              </IconBtn>
            ) : null}
            {supportsPip ? (
              <IconBtn onClick={onTogglePip} label="Picture in picture">
                <PictureInPicture2 className="h-5 w-5" />
              </IconBtn>
            ) : null}
            {/* On phones these live in Settings so the primary controls never
                run off-screen. Desktop keeps the one-tap quick switches. */}
            <div className="hidden items-center gap-2 sm:flex">
              <IconBtn
                onClick={() => {
                  setShowEpisodes(false);
                  onToggleSettings?.("server");
                }}
                label="Sources"
                active={settingsOpen && dockSection === "server"}
              >
                <Cloud className="h-5 w-5" />
              </IconBtn>
              <IconBtn
                onClick={() => {
                  setShowEpisodes(false);
                  onToggleSettings?.("subtitles");
                }}
                label="Subtitles"
                active={settingsOpen && dockSection === "subtitles"}
              >
                <Captions className="h-5 w-5" />
              </IconBtn>
            </div>
            <IconBtn
              onClick={() => {
                setShowEpisodes(false);
                onToggleSettings?.("quality");
              }}
              label="Settings"
              active={settingsOpen}
            >
              <Settings className="h-5 w-5" />
            </IconBtn>
            {supportsFullscreen ? (
              <IconBtn onClick={onToggleFullscreen} label="Fullscreen">
                {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </IconBtn>
            ) : null}
          </div>
        </div>
      </div>

      {shortcutsOpen && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-40 cursor-default bg-transparent"
            onClick={onToggleShortcuts}
            aria-label="Close keyboard shortcuts"
          />
          <div
            ref={shortcutsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            className="absolute bottom-16 right-4 z-50 w-64 rounded-xl border border-white/10 bg-[rgba(15,15,15,0.95)] p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-white/45">
                Shortcuts
              </div>
              <button
                type="button"
                onClick={onToggleShortcuts}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                aria-label="Close keyboard shortcuts"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {[
              ["Space", "Play / pause"],
              ["J / L", "±10s"],
              ["M", "Mute"],
              ["F", "Fullscreen"],
              ["C", "Captions"],
            ].map(([k, d]) => (
              <div key={k} className="flex justify-between px-2 py-1 text-xs text-white/70">
                <span>{d}</span>
                <kbd className="rounded border border-white/10 bg-white/10 px-1.5 font-mono text-[10px]">
                  {k}
                </kbd>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function IconBtn({
  onClick,
  label,
  active,
  children,
}: {
  onClick?: () => void;
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-11 w-11 items-center justify-center text-white transition hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        active && "opacity-100"
      )}
    >
      {children}
    </button>
  );
}
