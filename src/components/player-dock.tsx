"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Crown,
  Keyboard,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlayerStore, PLAYBACK_SPEEDS, type MediaTrack } from "@/stores/player-store";
import { buildServerSlots, type ServerSlot } from "@/lib/playback/expected-servers";
import {
  formatResolutionLabel,
  isSourcePlayableHere,
  preferenceKey,
} from "@/lib/playback/source-quality";
import { setPreferredProvider } from "@/lib/player-preferences";
import type { PlaybackSource } from "@/lib/playback/types";
import type {
  PlayerQualityOption,
  PlayerQualityTarget,
} from "@/lib/playback/quality-router";
import type { CSSProperties } from "react";

/** Floating settings card — same clear-glass family as nav / chips. */
const GLASS_DOCK_STYLE: CSSProperties = {
  background: "rgba(18, 18, 22, 0.42)",
  WebkitBackdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  backdropFilter: "blur(28px) saturate(180%) brightness(1.12)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -0.5px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.45)",
};

export type DockSection =
  | "quality"
  | "server"
  | "subtitles"
  | "audio"
  | "playback";

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
  onSourceChange: (source: PlaybackSource) => void;
  qualityTargets: PlayerQualityOption[];
  activeQualityTarget: PlayerQualityTarget;
  onQualityTargetChange: (target: PlayerQualityTarget) => void;
  onSubtitleChange: (trackId: number | null) => void;
  onAudioChange: (trackId: number) => void;
  onSetSpeed: (speed: number) => void;
  isDiscoveringSources?: boolean;
  failedSourceIds?: string[];
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
    case "checking":
      return "bg-zinc-400";
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
      aria-pressed={active}
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

const PRIMARY_TABS: Array<{ section: DockSection; label: string }> = [
  { section: "quality", label: "Quality" },
  { section: "server", label: "Sources" },
  { section: "subtitles", label: "Subtitles" },
  { section: "audio", label: "Audio" },
  { section: "playback", label: "Speed" },
];

export function PlayerDock({
  open,
  onClose,
  expandedSection,
  onExpandedSectionChange,
  sources,
  activeSourceId,
  onSourceChange,
  qualityTargets,
  activeQualityTarget,
  onQualityTargetChange,
  onSubtitleChange,
  onAudioChange,
  onSetSpeed,
  isDiscoveringSources,
  failedSourceIds = [],
  onOpenShortcuts,
  sleepMinutes: sleepMinutesProp = null,
  onSleepMinutesChange,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const playingHeight = usePlayerStore((s) => s.playingHeight);
  const subtitlesOn = usePlayerStore((s) => s.subtitlesOn);
  const subtitleTracks = usePlayerStore((s) => s.subtitleTracks);
  const audioTracks = usePlayerStore((s) => s.audioTracks);
  const activeSubtitleId = usePlayerStore((s) => s.activeSubtitleId);
  const activeAudioId = usePlayerStore((s) => s.activeAudioId);
  const speed = usePlayerStore((s) => s.speed);
  /** Local fallback only if parent did not lift sleep state (should be controlled). */
  const [sleepMinutesLocal, setSleepMinutesLocal] = useState<number | null>(null);
  const sleepMinutes = onSleepMinutesChange ? sleepMinutesProp : sleepMinutesLocal;
  const setSleepMinutes = (m: number | null) => {
    if (onSleepMinutesChange) onSleepMinutesChange(m);
    else setSleepMinutesLocal(m);
  };

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

  const hasSubtitleTracks = subtitleTracks.length > 0;

  const pickSource = (source: PlaybackSource) => {
    if (!isSourcePlayableHere(source)) return;
    setPreferredProvider(preferenceKey(source));
    onSourceChange(source);
  };

  const pickSubtitle = (trackId: number | null) => {
    onSubtitleChange(trackId);
  };

  const pickAudio = (trackId: number) => {
    onAudioChange(trackId);
  };

  const pickSpeed = (s: number) => {
    onSetSpeed(s);
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
        onClose();
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

  const activeSection = expandedSection ?? "quality";

  const renderOptions = () => {
    if (activeSection === "quality") {
      return (
        <div className="space-y-0.5">
          {qualityTargets.map((option) => {
            const disabled =
              option.status === "unavailable" || option.status === "searching";
            return (
              <OptionRow
                key={option.value}
                active={option.status === "active"}
                disabled={disabled}
                onClick={() => onQualityTargetChange(option.value)}
              >
                {option.label}
                {option.status === "searching" && (
                  <span className="text-white/40"> · searching</span>
                )}
                {option.status === "unavailable" && (
                  <span className="text-white/35"> · unavailable</span>
                )}
                {option.preferred && option.status !== "active" && (
                  <span className="text-white/40"> · default</span>
                )}
                {option.status === "active" &&
                  option.value !== activeQualityTarget && (
                    <span className="text-white/40"> · now</span>
                  )}
                {option.value === "auto" && playingHeight > 0 && (
                  <span className="text-white/40">
                    {" "}· now {formatResolutionLabel(playingHeight)}
                  </span>
                )}
              </OptionRow>
            );
          })}
        </div>
      );
    }

    if (activeSection === "server") {
      return (
        <div className="space-y-0.5">
          {serverSlots.length === 0 && (
            <div className="px-2 py-3 text-center text-[11px] text-white/50">Finding servers…</div>
          )}
          {serverSlots.map((slot) => {
            // Resolver/circuit-breaker dead rows are filtered before this
            // point; every row here represents a currently usable source.
            const failed = slot.status === "failed";
            const hasSource = !!slot.source;
            const selectable = !!slot.source && isSourcePlayableHere(slot.source);
            return (
              <button
                key={slot.id}
                type="button"
                data-source-id={slot.source?.id}
                data-source-provider={slot.source?.provider}
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
                {slot.flag && (
                  <span
                    className="shrink-0 text-sm"
                    aria-label={slot.flag === "🌐" ? "Global server" : "Server region"}
                  >
                    {slot.flag}
                  </span>
                )}
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
                {slot.status === "checking" && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-white/40">
                    Checking
                  </span>
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
        </div>
      );
    }

    if (activeSection === "subtitles" && hasSubtitleTracks) {
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

    if (activeSection === "subtitles") {
      return (
        <div className="px-2.5 py-4 text-center text-[11px] text-white/50">
          No subtitles on this source. Try another source for more tracks.
        </div>
      );
    }

    if (activeSection === "audio") {
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

    if (activeSection === "playback") {
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
          <div className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-white/40">
            Sleep timer
          </div>
          {[null, 15, 30, 45, 60, 90].map((minutes) => (
            <OptionRow
              key={minutes ?? "off"}
              active={sleepMinutes === minutes}
              onClick={() => setSleepMinutes(minutes)}
            >
              {minutes === null ? "Off" : `${minutes} minutes`}
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
        className="absolute bottom-16 left-3 right-3 z-50 w-auto origin-bottom animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 sm:bottom-14 sm:left-auto sm:right-4 sm:w-[25rem] sm:origin-bottom-right [&_button:focus-visible]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-white/80"
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
            <>
              <div className="flex items-center gap-1 border-b border-white/12 px-2 py-2">
                <div className="min-w-0 flex-1 text-[13px] font-semibold tracking-tight text-white">
                  Playback
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
              <div
                className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 py-2"
                role="tablist"
                aria-label="Playback settings"
              >
                {PRIMARY_TABS.map((tab) => (
                  <button
                    key={tab.section}
                    type="button"
                    role="tab"
                    aria-selected={activeSection === tab.section}
                    onClick={() => onExpandedSectionChange(tab.section)}
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition",
                      activeSection === tab.section
                        ? "bg-white text-black"
                        : "bg-white/[0.07] text-white/65 hover:bg-white/[0.12] hover:text-white"
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="max-h-[min(55vh,24rem)] overflow-y-auto p-2">{renderOptions()}</div>
            </>
          </div>
        </div>
      </div>
    </>
  );
}
