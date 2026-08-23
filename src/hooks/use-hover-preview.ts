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
}): { previewSrc: string | null; scoutRef: RefObject<HTMLVideoElement | null> } {
  const { videoRef, hoverTime } = options;
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

  // Continuous frame capture during regular playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastSampleTime = 0;
    const sample = () => {
      const now = Date.now();
      if (now - lastSampleTime < 1000) return;
      lastSampleTime = now;
      const url = captureVideoFrame(video);
      if (url) remember(video.currentTime, url);
    };

    video.addEventListener("timeupdate", sample);
    return () => video.removeEventListener("timeupdate", sample);
  }, [videoRef]);

  // Handle hover scrub preview
  useEffect(() => {
    if (hoverTime == null) {
      setPreviewSrc(null);
      return;
    }

    const cached = nearestPreviewFrame(framesRef.current, hoverTime);
    if (cached) {
      setPreviewSrc(cached);
    } else {
      setPreviewSrc(null);
    }

    const scout = scoutRef.current;
    const main = videoRef.current;
    if (!scout || !main?.currentSrc) return;

    if (scout.src !== main.currentSrc) {
      scout.crossOrigin = "anonymous";
      scout.src = main.currentSrc;
    }

    const handle = window.setTimeout(() => {
      try {
        if (scout.readyState >= 1) {
          scout.currentTime = hoverTime;
        }
      } catch {
        /* ignore unseekable hover */
      }
    }, 60);

    return () => window.clearTimeout(handle);
  }, [hoverTime, videoRef]);

  // Capture frame from scout on seeked
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
