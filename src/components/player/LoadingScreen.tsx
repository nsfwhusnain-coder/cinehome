"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { detectDeviceClass } from "@/lib/playback/device-profile";
import {
  bloomChips,
  bloomPhase,
  bloomPhaseCopy,
  bloomRosterCopy,
  FALLBACK_HUE,
  hexToHue,
  tmdbPathFromUrl,
  tmdbUrlAtSize,
} from "@/lib/playback/bloom-visuals";
import { orbitSignature } from "@/lib/playback/orbit-signature";
import "@/components/brand-mark.css";
import "./loading-bloom.css";

/**
 * Small on purpose — the panel upscales it into exactly the soft wash the glass
 * is meant to refract, with no filter to evaluate and roughly a twentieth of
 * the pixels to decode. See tmdbUrlAtSize().
 */
const TV_BACKDROP_RENDITION = "w300";

export interface LoadingScreenProps {
  backdropUrl?: string | null;
  /** Optional poster art; falls back to backdrop when omitted. */
  posterUrl?: string | null;
  serverName: string;
  title: string;
  visible: boolean;
  /** The player's own computed status line — read for phase, never displayed. */
  status?: string | null;
  /** Sources found so far (progressive discover). */
  sourceCount?: number;
  /** Still hunting more servers in the background. */
  discovering?: boolean;
  /** Debrid 4K sources in the roster — rendered as the larger, brighter chips. */
  premiumCount?: number;
  /** Roster index of the source being attached, or -1 while still choosing. */
  chosenIndex?: number;
  /** Buffer fill 0..1. Drives the core ring — the only true progress on screen. */
  bufferFill?: number;
  /** Stable per-title seed. Gives each film its own orbital geometry. */
  signatureSeed?: string;
}

/**
 * Opening Night — full-bleed pre-first-frame title sequence.
 *
 * The film's artwork becomes a living title card. The Absolute Cinema mark
 * sits in the centre as glass. Sources enter as stars. The only progress
 * indicator is the ring, and it is fed by real buffer state.
 */
export function LoadingScreen({
  backdropUrl,
  posterUrl,
  title,
  visible,
  status,
  sourceCount = 0,
  premiumCount = 0,
  chosenIndex = -1,
  bufferFill = 0,
  signatureSeed,
}: LoadingScreenProps) {
  const [hue, setHue] = useState<number>(FALLBACK_HUE);

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

  const phase = bloomPhase(status ?? null, sourceCount);
  const phaseCopy = bloomPhaseCopy(phase);
  const rosterCopy = bloomRosterCopy(sourceCount);
  const chips = useMemo(
    () => bloomChips(sourceCount, premiumCount, chosenIndex),
    [sourceCount, premiumCount, chosenIndex]
  );
  const signature = useMemo(
    () => orbitSignature(signatureSeed ?? title),
    [signatureSeed, title]
  );
  const deviceClass = useMemo(
    () => (visible ? detectDeviceClass() : "desktop"),
    [visible]
  );
  const artUrl = useMemo(
    () =>
      deviceClass === "tv"
        ? tmdbUrlAtSize(backdropUrl, TV_BACKDROP_RENDITION)
        : backdropUrl,
    [deviceClass, backdropUrl]
  );

  if (!visible) return null;

  const slots = Math.max(chips.length, 1);
  const fill = Math.min(1, Math.max(0, bufferFill));

  return (
    <div
      className={cn(
        "bloom-stage pointer-events-none absolute inset-0 z-40",
        "flex flex-col items-center justify-center overflow-hidden bg-black"
      )}
      data-phase={phase}
      data-device={deviceClass}
      style={
        {
          "--bloom-hue": hue,
          "--bloom-fill": fill,
          "--bloom-flare": `${signature.phaseDeg}deg`,
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`Loading ${title}`}
    >
      {artUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={artUrl} alt="" className="bloom-art" draggable={false} />
      ) : null}
      <div className="bloom-grade" />
      <div className="bloom-veil" />
      <div className="bloom-flare" />
      <div className="bloom-sweep" />

      <div
        className="bloom-system relative z-10"
        style={
          {
            "--tilt": `${signature.tiltDeg}deg`,
            "--orbit-dur": `${signature.periodS}s`,
            "--phase": `${signature.phaseDeg}deg`,
          } as React.CSSProperties
        }
      >
        <div className="bloom-aura" />
        <div className="bloom-halo" />
        <div className="bloom-orbit">
          {chips.map((chip) => (
            <div
              key={chip.index}
              className="bloom-arm"
              style={
                {
                  "--chip-delay": `${
                    -((chip.index / slots) * signature.periodS).toFixed(2)
                  }s`,
                } as React.CSSProperties
              }
            >
              <div
                className="bloom-planet"
                data-on="1"
                data-premium={chip.premium ? "1" : "0"}
                data-chosen={chip.chosen ? "1" : "0"}
                style={
                  {
                    "--chip-delay": `${
                      -((chip.index / slots) * signature.periodS).toFixed(2)
                    }s`,
                  } as React.CSSProperties
                }
              />
            </div>
          ))}
        </div>
        <div className="bloom-core">
          <div className="bloom-ring" />
          <span
            className="ab-glass bloom-mark"
            data-compact="false"
            aria-hidden
          >
            <span className="ab-glass__letter-wrap">
              <span className="ab-glass__letters">AB</span>
            </span>
          </span>
        </div>
      </div>

      <div className="bloom-copy relative z-10">
        <p className="bloom-wordmark">Absolute Cinema</p>
        <p className="bloom-title">{title}</p>
        <p className="bloom-phase">
          <span className="bloom-phase-dot" />
          {phaseCopy}
          {rosterCopy ? <span className="bloom-roster">{rosterCopy}</span> : null}
        </p>
      </div>

      <div className="bloom-dust" aria-hidden />
      <div className="bloom-dither" />
    </div>
  );
}
