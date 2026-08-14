"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { detectDeviceClass } from "@/lib/playback/device-profile";
import {
  bloomPhase,
  bloomPhaseCopy,
  bloomRosterCopy,
  FALLBACK_HUE,
  hexToHue,
  tmdbPathFromUrl,
  tmdbUrlAtSize,
} from "@/lib/playback/bloom-visuals";
import "@/components/brand-mark.css";
import "./loading-bloom.css";

const TV_POSTER_RENDITION = "w342";

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
}

/**
 * Title card — the film's poster, a quiet room, and a real buffer line.
 * No orbiting dots, no layout jumps, no blend-mode flicker.
 */
export function LoadingScreen({
  backdropUrl,
  posterUrl,
  title,
  visible,
  status,
  sourceCount = 0,
  bufferFill = 0,
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
  const deviceClass = useMemo(
    () => (visible ? detectDeviceClass() : "desktop"),
    [visible]
  );
  const posterSrc = useMemo(() => {
    const raw = posterUrl || backdropUrl;
    return deviceClass === "tv" ? tmdbUrlAtSize(raw, TV_POSTER_RENDITION) : raw;
  }, [deviceClass, posterUrl, backdropUrl]);
  const washSrc = useMemo(
    () =>
      deviceClass === "tv"
        ? tmdbUrlAtSize(backdropUrl || posterUrl, "w300")
        : backdropUrl || posterUrl,
    [deviceClass, backdropUrl, posterUrl]
  );

  if (!visible) return null;

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
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`Loading ${title}`}
    >
      {washSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={washSrc} alt="" className="bloom-wash" draggable={false} />
      ) : null}
      <div className="bloom-room" />

      <div className="bloom-card-wrap">
        {posterSrc ? (
          <div className="bloom-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={posterSrc} alt="" className="bloom-poster" draggable={false} />
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
        <p className="bloom-title">{title}</p>
        <div className="bloom-meter" aria-hidden>
          <span className="bloom-meter-fill" />
        </div>
        <p className="bloom-phase">
          {phaseCopy}
          {rosterCopy ? <span className="bloom-roster">{rosterCopy}</span> : null}
        </p>
      </div>

      <div className="bloom-dither" />
    </div>
  );
}
