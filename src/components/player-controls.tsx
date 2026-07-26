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
  Cast,
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
import { ServersPanel, type ServerItem } from "@/components/player/ServersPanel";
import {
  EpisodesPanel,
  type SeasonOption,
} from "@/components/player/EpisodesPanel";
import { flagForServerName } from "@/config/servers";
import { baseServerToken, getServerDisplayName, resolutionBadge } from "@/lib/playback/server-names";
import {
  isSourcePlayableHere,
  sourceHealthState,
  sourceMaxHeight,
} from "@/lib/playback/source-quality";
import type { QualityOption } from "@/lib/playback/hls-quality";
import { useEffect, useMemo, useRef, useState } from "react";

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
  activeSource?: PlaybackSource | null;
  onSourceChange: (source: PlaybackSource) => void;
  onTogglePlay: () => void;
  onSeekRelative: (seconds: number) => void;
  onSeekTo: (time: number) => void;
  onToggleMute: () => void;
  onSetVolume: (v: number) => void;
  onToggleFullscreen: () => void;
  onTogglePip: () => void;
  onToggleSettings?: () => void;
  onToggleSubtitles?: () => void;
  settingsOpen?: boolean;
  onToggleShortcuts?: () => void;
  shortcutsOpen?: boolean;
  dockSection: DockSection | null;
  onDockSectionChange: (section: DockSection | null) => void;
  onCloseDock: () => void;
  qualities: QualityOption[];
  activeQuality: number;
  onQualityChange: (level: number) => void;
  onSubtitleChange: (trackId: number | null) => void;
  onAudioChange: (trackId: number) => void;
  onSetSpeed: (speed: number) => void;
  hasNextEpisode?: boolean;
  onNextEpisode?: () => void;
  alwaysShowControls?: boolean;
  isDiscoveringSources?: boolean;
  failedSourceIds?: string[];
  levelsLoading?: boolean;
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
  activeSource,
  onSourceChange,
  onTogglePlay,
  onSeekRelative,
  onSeekTo,
  onToggleMute,
  onSetVolume,
  onToggleFullscreen,
  onTogglePip,
  onToggleSettings,
  onToggleSubtitles,
  settingsOpen,
  onToggleShortcuts,
  shortcutsOpen,
  dockSection,
  onDockSectionChange,
  onCloseDock,
  qualities,
  activeQuality,
  onQualityChange,
  onSubtitleChange,
  onAudioChange,
  onSetSpeed,
  hasNextEpisode,
  onNextEpisode,
  alwaysShowControls,
  isDiscoveringSources,
  failedSourceIds = [],
  levelsLoading,
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
  const subtitlesOn = usePlayerStore((s) => s.subtitlesOn);
  const subtitleTracks = usePlayerStore((s) => s.subtitleTracks);
  // Buffered edge lives in the store (not a VideoPlayer-level re-render prop) —
  // isolates the ~4x/sec update to this subtree instead of the 2,360-line parent.
  const buffered = usePlayerStore((s) => s.bufferedEnd);

  const [showServers, setShowServers] = useState(false);
  const [showSubsPanel, setShowSubsPanel] = useState(false);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const shortcutsDialogRef = useRef<HTMLDivElement>(null);
  const shortcutsPreviousFocusRef = useRef<HTMLElement | null>(null);

  const showTvEpisodes =
    mediaType === "tv" &&
    typeof tvId === "number" &&
    typeof tvSeason === "number" &&
    typeof tvEpisode === "number" &&
    !!onSelectEpisode;

  const controlsVisible =
    showControls || alwaysShowControls || !!settingsOpen || showServers || showEpisodes;

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
  const hasCaptions = subtitleTracks.length > 0;
  const failedSet = useMemo(() => new Set(failedSourceIds), [failedSourceIds]);

  // Freezes each source's row position the first time it's seen — background
  // probe updates and any upstream re-sort of `sources` must never reshuffle
  // or drop a row the owner has already looked at (owner req: switching
  // servers/reopening the panel must not make sources disappear or churn).
  // Adjusted DURING render (React's documented pattern for deriving state
  // from a prop change — see ServersPanel's own prior art for the same
  // idiom) rather than in an effect, so it never causes an extra committed
  // render; ids that genuinely leave the roster are pruned so the list
  // stays honest rather than accumulating stale entries forever.
  const [stableOrder, setStableOrder] = useState<string[]>([]);
  const [prevSources, setPrevSources] = useState(sources);
  if (sources !== prevSources) {
    setPrevSources(sources);
    const ids = sources.map((s) => s.id);
    const idSet = new Set(ids);
    const kept = stableOrder.filter((id) => idSet.has(id));
    const additions = ids.filter((id) => !kept.includes(id));
    if (additions.length > 0 || kept.length !== stableOrder.length) {
      setStableOrder([...kept, ...additions]);
    }
  }

  const serverRows: ServerItem[] = useMemo(() => {
    const byId = new Map(sources.map((s) => [s.id, s]));
    const known = stableOrder.filter((id) => byId.has(id));
    const pending = sources.map((s) => s.id).filter((id) => !known.includes(id));
    const orderedIds = [...known, ...pending];

    // Greek server name (never quality — that's `qualityLabel` below + the
    // separate Quality control) plus an honest per-row resolution badge.
    // `s.id` is passed so RD's identically-labeled native-1080p slots get a
    // stable Roman-numeral suffix from their OWN id, never from each other.
    const rows = orderedIds.map((id) => {
      const s = byId.get(id)!;
      const name = getServerDisplayName(s.provider, s.label, s.id);
      const failed = failedSet.has(s.id);
      const premium = s.origin === "debrid";
      return {
        id: s.id,
        name,
        // Premium sources carry the gold crown instead — a CDN-geography
        // flag has no meaning for a Real-Debrid/TorBox slot.
        flag: premium ? "" : flagForServerName(baseServerToken(s.provider, s.label)),
        active: s.id === activeSourceId,
        failed,
        health: sourceHealthState(s, failed),
        premium,
        playableHere: isSourcePlayableHere(s),
        height: sourceMaxHeight(s),
        qualityLabel: resolutionBadge(s),
      };
    });
    // Frozen order above already reflects upstream's playable-here +
    // healthiest + highest-resolution-first ordering from the first time
    // each row was seen; a hard runtime failure THIS session is the one
    // thing only this component knows about, so it alone still needs to
    // sink to the very bottom. Array#sort is stable — every other row's
    // relative (frozen) order is preserved.
    return [...rows].sort((a, b) => (a.failed ? 1 : 0) - (b.failed ? 1 : 0));
  }, [sources, stableOrder, activeSourceId, failedSet]);

  const closePanels = () => {
    setShowServers(false);
    setShowSubsPanel(false);
    onCloseDock();
  };

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
          className="flex h-9 w-9 items-center justify-center text-white transition hover:opacity-70"
          aria-label="Back"
        >
          <ArrowLeft className="h-7 w-7" strokeWidth={1.5} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[15px] font-medium text-white">
          {title}
        </div>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center text-white transition hover:opacity-70"
          aria-label="Cast"
        >
          <Cast className="h-[22px] w-[22px]" strokeWidth={1.5} />
        </button>
      </div>

      {/* Settings dock (quality/speed) */}
      <PlayerDock
        open={!!settingsOpen}
        onClose={onCloseDock}
        expandedSection={dockSection}
        onExpandedSectionChange={onDockSectionChange}
        sources={sources}
        activeSourceId={activeSourceId}
        activeSource={activeSource}
        onSourceChange={onSourceChange}
        qualities={qualities}
        activeQuality={activeQuality}
        onQualityChange={onQualityChange}
        onSubtitleChange={onSubtitleChange}
        onAudioChange={onAudioChange}
        onToggleSubtitles={onToggleSubtitles ?? (() => {})}
        onSetSpeed={onSetSpeed}
        isDiscoveringSources={isDiscoveringSources}
        failedSourceIds={failedSourceIds}
        levelsLoading={levelsLoading}
        sleepMinutes={sleepMinutes}
        onSleepMinutesChange={onSleepMinutesChange}
        onOpenShortcuts={() => {
          onCloseDock();
          onToggleShortcuts?.();
        }}
      />

      <ServersPanel
        open={showServers}
        servers={serverRows}
        onClose={() => setShowServers(false)}
        onSelect={(id) => {
          const src = sources.find((s) => s.id === id);
          if (src && isSourcePlayableHere(src)) onSourceChange(src);
          setShowServers(false);
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

      {/* Subtitles quick panel */}
      {showSubsPanel && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-[55] bg-transparent"
            onClick={() => setShowSubsPanel(false)}
            aria-label="Close subtitles"
          />
          <div
            className="absolute bottom-[60px] right-4 z-[60] w-[210px] overflow-hidden rounded-xl border border-white/10 bg-[rgba(15,15,15,0.95)] shadow-2xl backdrop-blur-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-white/10 px-3 py-2.5 text-sm font-semibold text-white">
              Subtitles
            </div>
            <div className="p-1.5">
              <button
                type="button"
                className="flex h-11 w-full items-center rounded-lg px-3 text-left text-sm text-white/90 hover:bg-white/[0.05]"
                onClick={() => {
                  onSubtitleChange(null);
                  setShowSubsPanel(false);
                }}
              >
                Off
              </button>
              {subtitleTracks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={cn(
                    "flex h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-white/[0.05]",
                    subtitlesOn && t.id === usePlayerStore.getState().activeSubtitleId
                      ? "bg-white/[0.08] text-white"
                      : "text-white/90"
                  )}
                  onClick={() => {
                    onSubtitleChange(t.id);
                    setShowSubsPanel(false);
                  }}
                >
                  {t.name || t.lang?.toUpperCase() || `Track ${t.id + 1}`}
                </button>
              ))}
              {subtitleTracks.length === 0 && (
                <div className="px-3 py-3 text-xs text-white/45">No tracks</div>
              )}
            </div>
          </div>
        </>
      )}

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
                  setShowServers(false);
                  setShowSubsPanel(false);
                  onCloseDock();
                  setShowEpisodes((v) => !v);
                }}
                label="Episodes"
                active={showEpisodes}
              >
                <ListVideo className="h-5 w-5" />
              </IconBtn>
            ) : null}
            <IconBtn onClick={onTogglePip} label="Picture in picture">
              <PictureInPicture2 className="h-5 w-5" />
            </IconBtn>
            {/* On phones these live in Settings so the primary controls never
                run off-screen. Desktop keeps the one-tap quick switches. */}
            <div className="hidden items-center gap-2 sm:flex">
              <IconBtn
                onClick={() => {
                  setShowSubsPanel(false);
                  setShowEpisodes(false);
                  onCloseDock();
                  setShowServers((v) => !v);
                }}
                label="Servers"
                active={showServers}
              >
                <Cloud className="h-5 w-5" />
              </IconBtn>
              <IconBtn
                onClick={() => {
                  setShowServers(false);
                  if (hasCaptions) {
                    setShowSubsPanel((v) => !v);
                  } else {
                    onToggleSubtitles?.();
                  }
                }}
                label="Subtitles"
                active={showSubsPanel || subtitlesOn}
              >
                <Captions className="h-5 w-5" />
              </IconBtn>
            </div>
            <IconBtn
              onClick={() => {
                setShowServers(false);
                setShowSubsPanel(false);
                setShowEpisodes(false);
                onToggleSettings?.();
              }}
              label="Settings"
              active={settingsOpen}
            >
              <Settings className="h-5 w-5" />
            </IconBtn>
            <IconBtn onClick={onToggleFullscreen} label="Fullscreen">
              {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </IconBtn>
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
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
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
        "flex h-9 w-9 items-center justify-center text-white transition hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        active && "opacity-100"
      )}
    >
      {children}
    </button>
  );
}
