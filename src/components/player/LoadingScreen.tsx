"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { detectDeviceClass } from "@/lib/playback/device-profile";
import {
  BLOOM_STEPS,
  bloomChips,
  bloomMeterProgress,
  bloomPhase,
  bloomPhaseCopy,
  bloomRosterCopy,
  bloomStepIndex,
  FALLBACK_HUE,
  hexToHue,
  tmdbPathFromUrl,
  tmdbUrlAtSize,
} from "@/lib/playback/bloom-visuals";
import "@/components/brand-mark.css";
import "./loading-bloom.css";

/** Netflix-style match-cut. TV / reduced-motion stay a short fade. */
const EXIT_MS = 1040;
const EXIT_MS_REDUCED = 400;

const TV_POSTER_RENDITION = "original";

export interface LoadingScreenProps {
  backdropUrl?: string | null;
  posterUrl?: string | null;
  serverName: string;
  title: string;
  visible: boolean;
  status?: string | null;
  sourceCount?: number;
  discovering?: boolean;
  premiumCount?: number;
  chosenIndex?: number;
  bufferFill?: number;
  signatureSeed?: string;
  /** When the player already knows Ultra/fast remux is packing, show this line. */
  waitHint?: string | null;
  /** Ultra is holding for a 4K source — copy should say so. */
  waitingForFourK?: boolean;
}

/**
 * Title card — the film's poster, a quiet room, and a real buffer line.
 * Motion is atmospheric; the meter and steps stay honest.
 */
export function LoadingScreen({
  backdropUrl,
  posterUrl,
  title,
  visible,
  status,
  sourceCount = 0,
  discovering = false,
  premiumCount = 0,
  chosenIndex = -1,
  bufferFill = 0,
  waitHint,
  waitingForFourK = false,
}: LoadingScreenProps) {
  const [hue, setHue] = useState<number>(FALLBACK_HUE);
  const [mounted, setMounted] = useState(visible);
  const [leaving, setLeaving] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [artReady, setArtReady] = useState(false);
  const [deviceClass, setDeviceClass] = useState(() =>
    typeof window === "undefined" ? "desktop" : detectDeviceClass()
  );
  const [reduceMotion, setReduceMotion] = useState(false);
  const fillFloorRef = useRef(0);
  const artPath = useMemo(
    () => tmdbPathFromUrl(posterUrl) ?? tmdbPathFromUrl(backdropUrl),
    [posterUrl, backdropUrl]
  );

  useEffect(() => {
    if (!visible || !artPath) return;
    let cancelled = false;
    const controller = new AbortController();
    void fetch(`/api/poster-color?path=${encodeURIComponent(artPath)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { color?: string } | null) => {
        if (cancelled || !json?.color) return;
        const next = hexToHue(json.color);
        if (next != null) setHue(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [visible, artPath]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (visible) setDeviceClass(detectDeviceClass());
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setLeaving(false);
      setElapsedMs(0);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const exitMs =
      reduceMotion || deviceClass === "tv" ? EXIT_MS_REDUCED : EXIT_MS;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
      fillFloorRef.current = 0;
      setElapsedMs(0);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [visible, mounted, reduceMotion, deviceClass]);

  useEffect(() => {
    if (!visible) return;
    const started = Date.now();
    const tick = window.setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [visible]);

  const phase = bloomPhase(status ?? null, sourceCount);
  const phaseCopy =
    waitHint?.trim() ||
    bloomPhaseCopy(phase, { waitingForFourK, elapsedMs });
  const rosterCopy = bloomRosterCopy(sourceCount);
  const displayTitle = title.trim() || "Loading";
  const rawFill = bloomMeterProgress(phase, sourceCount, bufferFill);
  const fill = Math.max(fillFloorRef.current, rawFill);
  fillFloorRef.current = fill;
  const step = bloomStepIndex(phase);
  const chips = useMemo(
    () => bloomChips(sourceCount, premiumCount, chosenIndex),
    [sourceCount, premiumCount, chosenIndex]
  );
  const posterSrc = useMemo(() => {
    const raw = posterUrl || backdropUrl;
    return deviceClass === "tv" ? tmdbUrlAtSize(raw, TV_POSTER_RENDITION) : raw;
  }, [deviceClass, posterUrl, backdropUrl]);
  const previewSrc = useMemo(
    () => (posterSrc ? tmdbUrlAtSize(posterSrc, "w780") : null),
    [posterSrc]
  );

  useEffect(() => {
    setArtReady(false);
  }, [posterSrc]);
  const washSrc = useMemo(
    () =>
      deviceClass === "tv"
        ? tmdbUrlAtSize(backdropUrl || posterUrl, "w300")
        : backdropUrl || posterUrl,
    [deviceClass, backdropUrl, posterUrl]
  );

  if (!mounted) return null;

  return (
    <div
      className={cn(
        "bloom-stage pointer-events-none absolute inset-0 z-40",
        "flex flex-col items-center justify-center overflow-hidden",
        leaving && "bloom-stage--out"
      )}
      data-phase={phase}
      data-device={deviceClass}
      data-discovering={discovering ? "true" : "false"}
      data-leaving={leaving ? "true" : "false"}
      style={
        {
          "--bloom-hue": hue,
          "--bloom-fill": fill,
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`Loading ${displayTitle}. ${phaseCopy}`}
    >
      {washSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={washSrc} alt="" className="bloom-wash" draggable={false} />
      ) : null}
      <div className="bloom-aurora" aria-hidden />
      <div className="bloom-room" />

      <div className="bloom-card-wrap">
        {posterSrc ? (
          <div className="bloom-card" data-art={artReady ? "ready" : "loading"}>
            <span className="bloom-card-sheen" aria-hidden />
            {previewSrc && previewSrc !== posterSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewSrc}
                alt=""
                className="bloom-poster bloom-poster--preview bloom-poster--ready"
                draggable={false}
              />
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={posterSrc}
              alt=""
              className={cn("bloom-poster", artReady && "bloom-poster--ready")}
              draggable={false}
              onLoad={() => setArtReady(true)}
              ref={(el) => {
                if (el?.complete && el.naturalWidth > 0) {
                  queueMicrotask(() => setArtReady(true));
                }
              }}
            />
          </div>
        ) : (
          <span className="ab-glass bloom-mark" data-compact="false" aria-hidden>
            <span className="ab-glass__letter-wrap">
              <span className="ab-glass__letters">AB</span>
            </span>
          </span>
        )}
      </div>

      <div className="bloom-copy">
        <p className="bloom-wordmark">Absolute Cinema</p>
        <p className="bloom-title">{displayTitle}</p>

        <ol className="bloom-steps" aria-hidden>
          {BLOOM_STEPS.map((label, index) => (
            <li
              key={label}
              className="bloom-step"
              data-state={index < step ? "done" : index === step ? "now" : "next"}
            >
              <span className="bloom-step-dot" />
              <span className="bloom-step-label">{label}</span>
            </li>
          ))}
        </ol>

        <div className="bloom-meter" aria-hidden>
          <span className="bloom-meter-pulse" />
          <span className="bloom-meter-fill" />
        </div>

        {chips.length > 0 ? (
          <div className="bloom-chips" aria-hidden>
            {chips.map((chip) => (
              <span
                key={chip.index}
                className="bloom-chip"
                data-premium={chip.premium ? "true" : "false"}
                data-chosen={chip.chosen ? "true" : "false"}
              />
            ))}
          </div>
        ) : (
          <div className="bloom-chips bloom-chips--empty" aria-hidden>
            <span className="bloom-chip bloom-chip--ghost" />
            <span className="bloom-chip bloom-chip--ghost" />
            <span className="bloom-chip bloom-chip--ghost" />
          </div>
        )}

        <p className="bloom-phase">
          {phaseCopy}
          {rosterCopy ? <span className="bloom-roster">{rosterCopy}</span> : null}
        </p>
      </div>

      <div className="bloom-dither" />
    </div>
  );
}
