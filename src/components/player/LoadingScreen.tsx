"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { detectDeviceClass } from "@/lib/playback/device-profile";
import {
  bloomChips,
  bloomPhase,
  FALLBACK_HUE,
  hexToHue,
  tmdbPathFromUrl,
  tmdbUrlAtSize,
} from "@/lib/playback/bloom-visuals";
import { orbitSignature } from "@/lib/playback/orbit-signature";
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
 * Spectrum Bloom — the full-bleed pre-first-frame overlay.
 *
 * Replaces the rotating status copy and the Finding/Connecting/Buffering rail
 * with light: the halo's width carries the stage, saturation carries
 * confidence, orbiting chips carry the roster, and the core ring carries the
 * buffer. Hue is the film's own, from the poster.
 *
 * The honesty rule from the screen this replaces is unchanged — no element
 * animates on a timer pretending to be progress. The ring is the only progress
 * indicator and it is fed by real buffer state.
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

  /**
   * The endpoint returns a deliberately darkened tint; we keep only its hue and
   * re-saturate in CSS. Failure is silent and simply keeps the brand neutral —
   * a loading screen must never depend on a colour lookup succeeding.
   */
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
  const chips = useMemo(
    () => bloomChips(sourceCount, premiumCount, chosenIndex),
    [sourceCount, premiumCount, chosenIndex]
  );
  /* Tilt, period and starting rotation derived from the title, so Dune and
     Fight Club are visibly different systems rather than the same one recoloured
     — and any given title looks identical every time it is opened. */
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

  return (
    <div
      className={cn(
        "bloom-stage pointer-events-none absolute inset-0 z-40",
        "flex flex-col items-center justify-center gap-8 overflow-hidden bg-black"
      )}
      data-phase={phase}
      data-device={deviceClass}
      style={
        {
          "--bloom-hue": hue,
          "--bloom-fill": Math.min(1, Math.max(0, bufferFill)),
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`Loading ${title}`}
    >
      {artUrl ? (
        // The glass refracts this, so it must sit behind and stay defocused.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={artUrl} alt="" className="bloom-art" draggable={false} />
      ) : null}
      <div className="bloom-veil" />

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
        <div className="bloom-orbit">
          {chips.map((chip) => (
            <div
              key={chip.index}
              className="bloom-arm"
              style={
                {
                  /* Negative delay starts each planet part-way round, so the
                     roster spreads across the orbit instead of leaving together
                     in a clump. Sharing one duration keeps the sweep and the
                     depth pass locked to each other. */
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
        <div className="bloom-globe">
          <div className="bloom-ring" />
        </div>
      </div>

      <p className="relative z-10 max-w-xl truncate px-6 text-center text-lg font-semibold tracking-tight text-white drop-shadow-[0_2px_26px_rgba(0,0,0,0.9)] sm:text-2xl">
        {title}
      </p>

      <div className="bloom-dither" />
    </div>
  );
}
