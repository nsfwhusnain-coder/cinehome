"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Crown,
  Download,
  Gauge,
  Keyboard,
  Loader2,
  Moon,
  Settings2,
  Subtitles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { GLASS_PILL_STYLE } from "@/components/glass-pill";
import { usePlayerStore, PLAYBACK_SPEEDS, type MediaTrack } from "@/stores/player-store";
import { buildServerSlots, type ServerSlot } from "@/lib/playback/expected-servers";
import { STABLE_SERVER_CAP } from "@/lib/playback/server-theme";
import {
  formatResolutionLabel,
  isSourcePlayableHere,
  preferenceKey,
  sourceMaxHeight,
} from "@/lib/playback/source-quality";
import {
  effectiveLevelHeight,
  isQualityMismatch,
  maxLevelHeight,
} from "@/lib/playback/hls-quality";
import { setPreferredProvider } from "@/lib/player-preferences";
import type { PlaybackSource } from "@/lib/playback/types";
import type { QualityOption } from "@/lib/playback/hls-quality";
import type { CSSProperties } from "react";

/** Floating settings card — same clear-glass family as nav / chips. */
const GLASS_DOCK_STYLE: CSSProperties = {
  background: "rgba(18, 18, 22, 0.42)",
  WebkitBackdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  backdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.45)",
};

const GLASS_TILE_STYLE: CSSProperties = {
  ...GLASS_PILL_STYLE,
  background: "rgba(255,255,255,0.08)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 4px 16px rgba(0,0,0,0.2)",
};

export type DockSection =
  | "quality"
  | "server"
  | "subtitles"
  | "audio"
  | "playback"
  | "subtitleSettings"
  | "sleep";

type DirectionKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

function focusableDockButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button:not([disabled])")).filter(
    (button) => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    }
  );
}

function directionalButton(
  current: HTMLButtonElement,
  candidates: HTMLButtonElement[],
  key: DirectionKey
): HTMLButtonElement | null {
  const from = current.getBoundingClientRect();
  const fromX = from.left + from.width / 2;
  const fromY = from.top + from.height / 2;
  let best: { button: HTMLButtonElement; score: number } | null = null;

  for (const button of candidates) {
    if (button === current) continue;
    const rect = button.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - fromX;
    const dy = rect.top + rect.height / 2 - fromY;
    const inDirection =
      (key === "ArrowLeft" && dx < -1) ||
      (key === "ArrowRight" && dx > 1) ||
      (key === "ArrowUp" && dy < -1) ||
      (key === "ArrowDown" && dy > 1);
    if (!inDirection) continue;

    const primary =
      key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dx) : Math.abs(dy);
    const cross =
      key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
    // Prefer the nearest control in the requested direction, strongly
    // penalising diagonal jumps so a D-pad follows the visual grid.
    const score = primary + cross * 2;
    if (!best || score < best.score) best = { button, score };
  }
  return best?.button ?? null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  expandedSection: DockSection | null;
  onExpandedSectionChange: (section: DockSection | null) => void;
  sources: PlaybackSource[];
  activeSourceId: string;
  activeSource?: PlaybackSource | null;
  onSourceChange: (source: PlaybackSource) => void;
  qualities: QualityOption[];
  activeQuality: number;
  onQualityChange: (level: number) => void;
  onSubtitleChange: (trackId: number | null) => void;
  onAudioChange: (trackId: number) => void;
  onToggleSubtitles: () => void;
  onSetSpeed: (speed: number) => void;
  isDiscoveringSources?: boolean;
  failedSourceIds?: string[];
  levelsLoading?: boolean;
  integrated?: boolean;
  onOpenShortcuts?: () => void;
  /** Controlled sleep timer (minutes); null = Off. Parent owns the actual timeout. */
  sleepMinutes?: number | null;
  onSleepMinutesChange?: (minutes: number | null) => void;
}

function statusDotClass(status: ReturnType<typeof buildServerSlots>[number]["status"]): string {
  switch (status) {
    case "active":
    case "available":
      return "bg-emerald-400";
    case "loading":
      return "bg-zinc-400 animate-pulse";
    case "failed":
      return "bg-red-400";
    default:
      return "bg-zinc-600";
  }
}

/** Unique audio row label — disambiguate same-lang tracks with Track N / channels. */
function formatAudioLabel(track: MediaTrack, allTracks: MediaTrack[]): string {
  const lang = (track.lang ?? "").toLowerCase();
  const name = track.name.trim();
  let base: string;
  if (lang.startsWith("en") || name.toLowerCase().includes("english")) {
    // Prefer pre-disambiguated name from mapAudioTracks when present.
    if (name.includes("·") || /track\s*\d+/i.test(name)) return name;
    base = "English";
  } else if (name) {
    base = name;
  } else if (track.lang) {
    base = track.lang.toUpperCase();
  } else {
    base = "Audio";
  }

  if (allTracks.length <= 1) return base;

  const langKey = lang || name.toLowerCase() || String(track.id);
  const sameLang = allTracks.filter((t) => {
    const k = (t.lang ?? "").toLowerCase() || t.name.toLowerCase() || String(t.id);
    return k === langKey || (
      // Collapsed English group: any eng/*english* when base is English
      base === "English" &&
      ((t.lang ?? "").toLowerCase().startsWith("en") || t.name.toLowerCase().includes("english"))
    );
  });

  if (sameLang.length <= 1) return base;

  // Name already unique (e.g. "English · Track 2" from player map) — use as-is.
  if (name.includes("·") || /track\s*\d+/i.test(name)) return name;

  const ordinal = sameLang.findIndex((t) => t.id === track.id) + 1;
  if (track.channels) {
    return `${base} · ${track.channels} · Track ${ordinal}`;
  }
  return `${base} · Track ${ordinal}`;
}

function OptionRow({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[13px] transition-colors",
        disabled && "cursor-default opacity-55",
        !disabled && !active && "border-transparent hover:border-white/10 hover:bg-white/[0.08]",
        active
          ? "border-white/20 bg-white/15 font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
          : "text-white/75"
      )}
    >
      <span className="w-4 shrink-0">
        {active ? <Check className="h-3.5 w-3.5 text-white" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

const SECTION_TITLES: Record<DockSection, string> = {
  quality: "Quality",
  server: "Server",
  subtitles: "Subtitles",
  audio: "Audio",
  playback: "Playback Settings",
  subtitleSettings: "Subtitle Settings",
  sleep: "Sleep Timer",
};

export function PlayerDock({
  open,
  onClose,
  expandedSection,
  onExpandedSectionChange,
  sources,
  activeSourceId,
  activeSource,
  onSourceChange,
  qualities,
  activeQuality,
  onQualityChange,
  onSubtitleChange,
  onAudioChange,
  onToggleSubtitles,
  onSetSpeed,
  isDiscoveringSources,
  failedSourceIds = [],
  levelsLoading,
  onOpenShortcuts,
  sleepMinutes: sleepMinutesProp = null,
  onSleepMinutesChange,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const quality = usePlayerStore((s) => s.quality);
  const playingHeight = usePlayerStore((s) => s.playingHeight);
  const levels = usePlayerStore((s) => s.levels);
  const subtitlesOn = usePlayerStore((s) => s.subtitlesOn);
  const subtitleTracks = usePlayerStore((s) => s.subtitleTracks);
  const audioTracks = usePlayerStore((s) => s.audioTracks);
  const activeSubtitleId = usePlayerStore((s) => s.activeSubtitleId);
  const activeAudioId = usePlayerStore((s) => s.activeAudioId);
  const speed = usePlayerStore((s) => s.speed);
  const serverDisplayName = usePlayerStore((s) => s.serverDisplayName);
  /** Local fallback only if parent did not lift sleep state (should be controlled). */
  const [sleepMinutesLocal, setSleepMinutesLocal] = useState<number | null>(null);
  const sleepMinutes = onSleepMinutesChange ? sleepMinutesProp : sleepMinutesLocal;
  const setSleepMinutes = (m: number | null) => {
    if (onSleepMinutesChange) onSleepMinutesChange(m);
    else setSleepMinutesLocal(m);
  };

  const resolvedSource = activeSource ?? sources.find((s) => s.id === activeSourceId);
  const isHls = resolvedSource?.type === "hls";
  const manifestMaxRes = maxLevelHeight(levels);
  const fixedRes = resolvedSource ? sourceMaxHeight(resolvedSource) : 0;

  const rawServerSlots = useMemo(
    () => buildServerSlots(sources, failedSourceIds, !!isDiscoveringSources, activeSourceId),
    [sources, failedSourceIds, isDiscoveringSources, activeSourceId]
  );

  // Freezes each slot's row position the first time it's seen — same
  // rationale/idiom as the Cloud-panel quick switch (player-controls.tsx):
  // `buildServerSlots` re-ranks by live score on every call (a background
  // probe finishing re-orders `sources`), and this settings-dock Server
  // section must not visibly reshuffle or drop a row the owner already
  // looked at just because of that. Adjusted DURING render (React's
  // documented "derive state from a prop change" pattern) rather than in an
  // effect, so it never causes an extra committed render.
  const [stableSlotOrder, setStableSlotOrder] = useState<string[]>([]);
  const [prevRawSlots, setPrevRawSlots] = useState(rawServerSlots);
  if (rawServerSlots !== prevRawSlots) {
    setPrevRawSlots(rawServerSlots);
    const ids = rawServerSlots.map((s) => s.id);
    const idSet = new Set(ids);
    const kept = stableSlotOrder.filter((id) => idSet.has(id));
    const additions = ids.filter((id) => !kept.includes(id));
    if (additions.length > 0 || kept.length !== stableSlotOrder.length) {
      setStableSlotOrder([...kept, ...additions]);
    }
  }

  const serverSlots: ServerSlot[] = useMemo(() => {
    const byId = new Map(rawServerSlots.map((s) => [s.id, s]));
    const known = stableSlotOrder.filter((id) => byId.has(id));
    const pending = rawServerSlots.map((s) => s.id).filter((id) => !known.includes(id));
    const ordered = [...known, ...pending].map((id) => byId.get(id)!);
    // A hard runtime failure THIS session (slotStatus → "failed") still
    // sinks to the very bottom even once frozen — Array#sort is stable, so
    // every other row's relative (frozen) order is preserved.
    return [...ordered].sort((a, b) => (a.status === "failed" ? 1 : 0) - (b.status === "failed" ? 1 : 0));
  }, [rawServerSlots, stableSlotOrder]);

  const [serverListExpanded, setServerListExpanded] = useState(false);
  const visibleServerSlots = serverListExpanded
    ? serverSlots
    : serverSlots.slice(0, STABLE_SERVER_CAP);
  const hiddenServerCount = serverSlots.length - visibleServerSlots.length;

  const activeServerName =
    serverSlots.find((s) => s.status === "active")?.name ?? serverDisplayName ?? "—";

  // Selected preference vs actual LEVEL_SWITCHED / decoded height.
  // Never fall back to source metadata maxHeight for "now playing" chrome.
  const selectedLevel = quality === -1 ? undefined : levels.find((l) => l.index === quality);
  const selectedHeight = selectedLevel ? effectiveLevelHeight(selectedLevel) : 0;
  const selectedLabel =
    quality === -1
      ? "Auto"
      : qualities.find((q) => q.index === quality)?.label ??
        (selectedHeight > 0 ? formatResolutionLabel(selectedHeight) : "Auto");
  const actualLabel =
    playingHeight > 0
      ? formatResolutionLabel(playingHeight)
      : null;
  const qualityMismatch = isQualityMismatch(selectedHeight, playingHeight, quality);
  const qualityLabel =
    quality === -1
      ? actualLabel
        ? `Auto · ${actualLabel}`
        : "Auto"
      : qualityMismatch && actualLabel
        ? `${selectedLabel} · ${actualLabel}`
        : selectedLabel;
  const qualityHint =
    qualityMismatch && actualLabel
      ? `Playing ${actualLabel} — target ${selectedLabel}`
      : null;

  const hasSubtitleTracks = subtitleTracks.length > 0;

  const subtitleLabel =
    !subtitlesOn || activeSubtitleId === null
      ? "Off"
      : subtitleTracks.find((t) => t.id === activeSubtitleId)?.name ??
        subtitleTracks.find((t) => t.id === activeSubtitleId)?.lang?.toUpperCase() ??
        "On";

  const audioLabel =
    audioTracks.length > 0
      ? formatAudioLabel(
          audioTracks.find((t) => t.id === activeAudioId) ?? audioTracks[0]!,
          audioTracks
        )
      : "Default";

  useEffect(() => {
    if (expandedSection === "subtitles" && !hasSubtitleTracks) {
      onExpandedSectionChange(null);
    }
    // Audio stays openable with 0–1 tracks (status message, not auto-close).
  }, [expandedSection, hasSubtitleTracks, onExpandedSectionChange]);

  const pickQuality = (level: number) => {
    onQualityChange(level);
    onExpandedSectionChange(null);
  };

  const pickSource = (source: PlaybackSource) => {
    if (!isSourcePlayableHere(source)) return;
    setPreferredProvider(preferenceKey(source));
    onSourceChange(source);
    onExpandedSectionChange(null);
  };

  const pickSubtitle = (trackId: number | null) => {
    onSubtitleChange(trackId);
    onExpandedSectionChange(null);
  };

  const pickAudio = (trackId: number) => {
    onAudioChange(trackId);
    onExpandedSectionChange(null);
  };

  const pickSpeed = (s: number) => {
    onSetSpeed(s);
    onExpandedSectionChange(null);
  };

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      focusableDockButtons(root)[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, expandedSection]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (expandedSection) onExpandedSectionChange(null);
        else onClose();
        return;
      }

      const root = dialogRef.current;
      if (!root) return;
      const buttons = focusableDockButtons(root);
      if (e.key === "Tab") {
        if (buttons.length === 0) return;
        e.preventDefault();
        const activeIndex = buttons.findIndex((button) => button === document.activeElement);
        const delta = e.shiftKey ? -1 : 1;
        const nextIndex =
          activeIndex < 0
            ? 0
            : (activeIndex + delta + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
        return;
      }

      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown"
      ) {
        e.preventDefault();
        const current =
          document.activeElement instanceof HTMLButtonElement &&
          root.contains(document.activeElement)
            ? document.activeElement
            : buttons[0];
        if (!current) return;
        (directionalButton(current, buttons, e.key) ?? current).focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, expandedSection, onExpandedSectionChange]);

  if (!open) return null;

  const isAdaptive = isHls || resolvedSource?.type === "dash";
  const showQualityLoading = !!resolvedSource && isAdaptive && levelsLoading;
  const hasHlsQualities = qualities.length > 0;
  const maxRes = manifestMaxRes || fixedRes;

  const renderOptions = () => {
    if (expandedSection === "quality") {
      if (!resolvedSource) {
        return <div className="px-2 py-3 text-center text-[11px] text-white/50">Select a source first</div>;
      }
      if (showQualityLoading) {
        return (
          <div className="flex items-center justify-center gap-1.5 px-2 py-4 text-[11px] text-white/60">
            <Loader2 className="h-3 w-3 animate-spin text-[#c026d3]" />
            Loading qualities…
          </div>
        );
      }
      // Ladder tops out below 1080 (or the source is a fixed sub-HD rendition) —
      // point the user at the multi-server switcher instead of pretending HD
      // is available. Guarded on maxRes > 0 so an unknown ceiling never shows
      // a false warning (sourceMaxHeight/formatResolutionLabel already never
      // surface "0p"/"undefinedp" — 0 always means "unknown", not "bad").
      const belowHd = maxRes > 0 && maxRes < 1080;
      return (
        <div className="space-y-0.5">
          <OptionRow active={activeQuality === -1} onClick={() => pickQuality(-1)}>
            Auto
            {maxRes > 0 && (
              <span className="text-white/40"> (up to {formatResolutionLabel(maxRes)})</span>
            )}
          </OptionRow>
          {hasHlsQualities ? (
            qualities.map((q) => (
              <OptionRow
                key={`${q.index}-${q.label}`}
                active={activeQuality === q.index}
                onClick={() => pickQuality(q.index)}
              >
                {q.label}
                {qualities.length === 1 && !q.isMaxAvailable && (
                  <span className="text-white/40"> only</span>
                )}
                {q.isMaxAvailable && <span className="text-white/40"> · max available</span>}
              </OptionRow>
            ))
          ) : (
            <div className="px-2 py-1.5 text-[10px] text-white/45">
              {fixedRes > 0
                ? `${formatResolutionLabel(fixedRes)} only — switch Servers for other qualities`
                : "No quality rungs — switch Servers for other sources"}
            </div>
          )}
          {hasHlsQualities && qualities.length === 1 && (
            <button
              type="button"
              onClick={() => onExpandedSectionChange("server")}
              className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] leading-snug text-white/50 transition-colors hover:bg-white/[0.06]"
            >
              This server is fixed quality — open Servers for more options
            </button>
          )}
          {belowHd && (
            <button
              type="button"
              onClick={() => onExpandedSectionChange("server")}
              className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] leading-snug text-amber-200/80 transition-colors hover:bg-white/[0.06]"
            >
              Best on this server: {formatResolutionLabel(maxRes)} — try another server for HD
            </button>
          )}
        </div>
      );
    }

    if (expandedSection === "server") {
      return (
        <div className="space-y-0.5">
          {serverSlots.length === 0 && (
            <div className="px-2 py-3 text-center text-[11px] text-white/50">Finding servers…</div>
          )}
          {visibleServerSlots.map((slot) => {
            // Failed stays greyed but clickable (manual retry) — never
            // removed, never disabled. Same rule as the Cloud-panel list.
            const failed = slot.status === "failed";
            const hasSource = !!slot.source;
            const selectable = !!slot.source && isSourcePlayableHere(slot.source);
            return (
              <button
                key={slot.id}
                type="button"
                disabled={hasSource && !selectable}
                onClick={() => selectable && slot.source && pickSource(slot.source)}
                aria-label={
                  hasSource && !selectable
                    ? `${slot.name} — unavailable in this browser`
                    : slot.name
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors",
                  selectable && "hover:bg-white/10",
                  slot.status === "active" && "bg-white/10 font-medium text-white",
                  failed && "opacity-55",
                  !failed && slot.status !== "active" && "text-white/75",
                  hasSource && !selectable && "cursor-not-allowed opacity-45"
                )}
              >
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass(slot.status))}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{slot.name}</span>
                {slot.premium && (
                  <Crown className="h-3 w-3 shrink-0 text-amber-400" aria-label="Premium (Real-Debrid)" />
                )}
                {slot.qualityLabel && (
                  <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/55">
                    {slot.qualityLabel}
                  </span>
                )}
                {slot.status === "loading" && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-white/40" />
                )}
                {slot.status === "active" && <Check className="h-3.5 w-3.5 shrink-0 text-[#c026d3]" />}
                {hasSource && !selectable && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-white/40">
                    Unavailable
                  </span>
                )}
              </button>
            );
          })}
          {hiddenServerCount > 0 && (
            <button
              type="button"
              onClick={() => setServerListExpanded(true)}
              className="w-full rounded-xl px-2.5 py-2 text-center text-[12px] font-medium text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white/80"
            >
              Show {hiddenServerCount} more server{hiddenServerCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
      );
    }

    if (expandedSection === "subtitles" && hasSubtitleTracks) {
      return (
        <div className="space-y-0.5">
          <OptionRow
            active={!subtitlesOn || activeSubtitleId === null}
            onClick={() => pickSubtitle(null)}
          >
            Off
          </OptionRow>
          {subtitleTracks.map((track) => (
            <OptionRow
              key={track.id}
              active={subtitlesOn && activeSubtitleId === track.id}
              onClick={() => pickSubtitle(track.id)}
            >
              {track.name || track.lang?.toUpperCase() || `Track ${track.id + 1}`}
            </OptionRow>
          ))}
        </div>
      );
    }

    if (expandedSection === "audio") {
      // List every track when 2+ exist — even if langs collide (e.g. two "eng").
      if (audioTracks.length > 1) {
        return (
          <div className="space-y-0.5">
            {audioTracks.map((track) => (
              <OptionRow
                key={track.id}
                active={activeAudioId === track.id}
                onClick={() => pickAudio(track.id)}
              >
                {formatAudioLabel(track, audioTracks)}
              </OptionRow>
            ))}
          </div>
        );
      }
      if (audioTracks.length === 1) {
        const only = audioTracks[0]!;
        return (
          <div className="space-y-0.5">
            <OptionRow active onClick={() => pickAudio(only.id)}>
              {formatAudioLabel(only, audioTracks)}
            </OptionRow>
            <div className="px-2.5 py-2 text-[11px] leading-snug text-white/45">
              This stream only has one audio track. Try another server for more languages.
            </div>
          </div>
        );
      }
      return (
        <div className="px-2.5 py-3 text-center text-[11px] leading-snug text-white/50">
          No alternate audio on this stream. Switch server if available — some hosts expose
          multi-language tracks.
        </div>
      );
    }

    if (expandedSection === "playback") {
      return (
        <div className="space-y-0.5">
          <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
            Speed
          </div>
          {PLAYBACK_SPEEDS.map((s) => (
            <OptionRow key={s} active={speed === s} onClick={() => pickSpeed(s)}>
              {s === 1 ? "Normal" : `${s}x`}
            </OptionRow>
          ))}
          {onOpenShortcuts && (
            <button
              type="button"
              onClick={onOpenShortcuts}
              className="mt-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-white/70 hover:bg-white/10"
            >
              <Keyboard className="h-4 w-4 text-white/45" />
              Keyboard shortcuts
            </button>
          )}
        </div>
      );
    }

    if (expandedSection === "subtitleSettings") {
      return (
        <div className="space-y-2 px-1 py-1">
          {hasSubtitleTracks ? (
            <>
              <OptionRow
                active={!subtitlesOn || activeSubtitleId === null}
                onClick={() => pickSubtitle(null)}
              >
                Off
              </OptionRow>
              {subtitleTracks.map((track) => (
                <OptionRow
                  key={track.id}
                  active={subtitlesOn && activeSubtitleId === track.id}
                  onClick={() => pickSubtitle(track.id)}
                >
                  {track.name || track.lang?.toUpperCase() || `Track ${track.id + 1}`}
                </OptionRow>
              ))}
            </>
          ) : (
            <div className="px-2 py-3 text-center text-[11px] text-white/50">
              No subtitles on this stream
            </div>
          )}
        </div>
      );
    }

    if (expandedSection === "sleep") {
      const options = [15, 30, 45, 60, 90];
      return (
        <div className="space-y-0.5">
          <OptionRow
            active={sleepMinutes === null}
            onClick={() => {
              setSleepMinutes(null);
              onExpandedSectionChange(null);
            }}
          >
            Off
          </OptionRow>
          {options.map((m) => (
            <OptionRow
              key={m}
              active={sleepMinutes === m}
              onClick={() => {
                setSleepMinutes(m);
                onExpandedSectionChange(null);
              }}
            >
              {m} minutes
            </OptionRow>
          ))}
        </div>
      );
    }

    return null;
  };

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-40 cursor-default bg-transparent"
        aria-label="Close settings"
        onClick={onClose}
      />
      {/* Glass floating card — bottom-right over video (nav pill material) */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Player settings"
        className="absolute bottom-16 right-3 z-50 w-[min(17.5rem,calc(100vw-1.5rem))] origin-bottom-right animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 sm:bottom-14 sm:right-4 [&_button:focus-visible]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative overflow-hidden rounded-[1.25rem] border border-white/20"
          style={GLASS_DOCK_STYLE}
        >
          {/* Specular edge (same family as GlassPill) */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[1.25rem]"
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
          <div className="relative z-[1]">
          {expandedSection ? (
            <>
              <div className="flex items-center gap-1 border-b border-white/12 px-2 py-2">
                <button
                  type="button"
                  onClick={() => onExpandedSectionChange(null)}
                  className="rounded-full p-1.5 text-white/80 transition hover:bg-white/15 hover:text-white"
                  aria-label="Back"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1 text-[13px] font-semibold tracking-tight text-white">
                  {SECTION_TITLES[expandedSection]}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full p-1.5 text-white/55 transition hover:bg-white/15 hover:text-white"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[min(50vh,20rem)] overflow-y-auto p-1.5">{renderOptions()}</div>
            </>
          ) : (
            <div className="p-2.5">
              {/* 2×2 glass tiles — Quality / Server / Subtitles / Audio */}
              <div className="grid grid-cols-2 gap-2">
                <Tile
                  icon={<Settings2 className="h-3.5 w-3.5" />}
                  label="Quality"
                  value={qualityLabel}
                  onClick={() => onExpandedSectionChange("quality")}
                />
                {qualityHint ? (
                  <p className="col-span-2 px-1 text-[10px] leading-snug text-amber-200/80">
                    {qualityHint}
                  </p>
                ) : null}
                <Tile
                  icon={<span className="text-[10px] font-bold leading-none">☰</span>}
                  label="Server"
                  value={activeServerName}
                  onClick={() => onExpandedSectionChange("server")}
                  pulse={isDiscoveringSources}
                />
                <Tile
                  icon={<Subtitles className="h-3.5 w-3.5" />}
                  label="Subtitles"
                  value={subtitleLabel}
                  onClick={() =>
                    hasSubtitleTracks
                      ? onExpandedSectionChange("subtitles")
                      : onExpandedSectionChange("subtitleSettings")
                  }
                />
                <Tile
                  icon={<span className="text-[11px] font-semibold leading-none">♪</span>}
                  label="Audio"
                  value={audioLabel}
                  onClick={() => onExpandedSectionChange("audio")}
                />
              </div>

              <div className="mt-2 space-y-1">
                <MenuRow
                  icon={<Download className="h-4 w-4" />}
                  label="Download"
                  onClick={() => {
                    /* no local download — chrome match only */
                  }}
                  muted
                />
                <MenuRow
                  icon={<Moon className="h-4 w-4" />}
                  label="Sleep Timer"
                  value={sleepMinutes ? `${sleepMinutes}m` : undefined}
                  onClick={() => onExpandedSectionChange("sleep")}
                />
              </div>

              <div className="mt-2 space-y-1 border-t border-white/12 pt-2">
                <div
                  className="flex items-center gap-2.5 rounded-2xl border border-white/12 px-2.5 py-2"
                  style={GLASS_TILE_STYLE}
                >
                  <Subtitles className="h-4 w-4 shrink-0 text-white/65" />
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-white/95">
                    Subtitles
                  </span>
                  <Switch
                    checked={subtitlesOn && hasSubtitleTracks}
                    disabled={!hasSubtitleTracks}
                    onCheckedChange={() => {
                      if (hasSubtitleTracks) onToggleSubtitles();
                    }}
                    className="data-[state=checked]:bg-white data-[state=checked]:text-black"
                  />
                </div>
                <MenuRow
                  icon={<Gauge className="h-4 w-4" />}
                  label="Playback Settings"
                  onClick={() => onExpandedSectionChange("playback")}
                />
                <MenuRow
                  icon={<span className="text-[11px] font-semibold text-white/65">Tt</span>}
                  label="Subtitle Settings"
                  onClick={() => onExpandedSectionChange("subtitleSettings")}
                />
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </>
  );
}

function Tile({
  icon,
  label,
  value,
  onClick,
  pulse,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
  pulse?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={disabled ? undefined : GLASS_TILE_STYLE}
      className={cn(
        "relative flex flex-col items-start gap-1 overflow-hidden rounded-2xl border border-white/20 px-2.5 py-2.5 text-left transition",
        !disabled && "hover:brightness-110 active:scale-[0.98]",
        disabled && "cursor-default border-white/10 bg-white/[0.04] opacity-60"
      )}
    >
      <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/50">
        <span className="text-white/60">{icon}</span>
        {label}
        {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
      </span>
      <span className="w-full truncate text-[13px] font-semibold tracking-tight text-white">
        {value}
      </span>
    </button>
  );
}

function MenuRow({
  icon,
  label,
  value,
  onClick,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClick?: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={muted ? undefined : GLASS_TILE_STYLE}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-2xl border border-white/12 px-2.5 py-2 text-left transition",
        !muted && "hover:brightness-110",
        muted && "border-transparent bg-transparent opacity-55 hover:bg-white/[0.06]"
      )}
    >
      <span className="shrink-0 text-white/65">{icon}</span>
      <span className="min-w-0 flex-1 text-[13px] font-medium text-white/95">{label}</span>
      {value && <span className="shrink-0 text-[12px] text-white/55">{value}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-white/40" />
    </button>
  );
}
