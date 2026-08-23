"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  PREVIEW_MAX_FRAMES,
  captureVideoFrame,
  nearestPreviewFrame,
  previewBucket,
} from "@/lib/playback/hover-preview";

/**
 * Builds a smooth hover video frame thumbnail preview.
 * Captures real frames during playback into a ring buffer, and uses an invisible
 * scout video element for fast frame rendering when scrubbing ahead.
 */
export function useHoverPreview(options: {
  videoRef: RefObject<HTMLVideoElement | null>;
  hoverTime: number | null;
  remux?: boolean;
  poster?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
}): { previewSrc: string | null; scoutRef: RefObject<HTMLVideoElement | null> } {
  const { videoRef, hoverTime, sourceUrl, sourceType } = options;
  const framesRef = useRef(new Map<number, string>());
  const orderRef = useRef<number[]>([]);
  const scoutRef = useRef<HTMLVideoElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const remember = (timeS: number, url: string) => {
    if (!url) return;
    const key = previewBucket(timeS);
    const frames = framesRef.current;
    if (!frames.has(key)) {
      orderRef.current.push(key);
      if (orderRef.current.length > PREVIEW_MAX_FRAMES) {
        const oldest = orderRef.current.shift();
        if (oldest != null) frames.delete(oldest);
      }
    }
    frames.set(key, url);
  };

  // Continuous frame capture during regular playback, seeking, and timeupdate
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastSampleTime = 0;
    const sample = () => {
      const now = Date.now();
      if (now - lastSampleTime < 400) return;
      lastSampleTime = now;
      const url = captureVideoFrame(video);
      if (url) {
        remember(video.currentTime, url);
      }
    };

    video.addEventListener("timeupdate", sample);
    video.addEventListener("seeked", sample);
    video.addEventListener("seeking", sample);
    video.addEventListener("playing", sample);
    return () => {
      video.removeEventListener("timeupdate", sample);
      video.removeEventListener("seeked", sample);
      video.removeEventListener("seeking", sample);
      video.removeEventListener("playing", sample);
    };
  }, [videoRef]);

  // Synchronize scout element with source media
  useEffect(() => {
    const scout = scoutRef.current;
    const main = videoRef.current;
    if (!scout) return;

    // Use direct URL if available and not a blob
    const targetSrc =
      sourceUrl && !sourceUrl.startsWith("blob:") && sourceType !== "hls" && sourceType !== "dash"
        ? sourceUrl
        : main?.currentSrc && !main.currentSrc.startsWith("blob:")
          ? main.currentSrc
          : null;

    if (targetSrc && scout.src !== targetSrc) {
      scout.crossOrigin = "anonymous";
      scout.preload = "auto";
      scout.src = targetSrc;
    }
  }, [sourceUrl, sourceType, videoRef]);

  // Handle hover scrub preview
  useEffect(() => {
    if (hoverTime == null) {
      setPreviewSrc(null);
      return;
    }

    // First, check if we have a captured frame near hoverTime
    const cached = nearestPreviewFrame(framesRef.current, hoverTime);
    if (cached) {
      setPreviewSrc(cached);
    }

    const scout = scoutRef.current;
    if (!scout || !scout.src) return;

    const handle = window.setTimeout(() => {
      try {
        if (scout.readyState >= 1) {
          scout.currentTime = hoverTime;
        }
      } catch {
        /* ignore unseekable hover */
      }
    }, 40);

    return () => window.clearTimeout(handle);
  }, [hoverTime]);

  // Capture frame from scout on seeked and canplay
  useEffect(() => {
    const scout = scoutRef.current;
    if (!scout) return;

    const onSeeked = () => {
      const url = captureVideoFrame(scout);
      if (!url) return;
      remember(scout.currentTime, url);
      setPreviewSrc(url);
    };

    scout.addEventListener("seeked", onSeeked);
    scout.addEventListener("canplay", onSeeked);
    return () => {
      scout.removeEventListener("seeked", onSeeked);
      scout.removeEventListener("canplay", onSeeked);
    };
  }, []);

  return { previewSrc, scoutRef };
}
