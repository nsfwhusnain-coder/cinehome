"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  PREVIEW_MAX_FRAMES,
  captureVideoFrame,
  nearestPreviewFrame,
  previewBucket,
} from "@/lib/playback/hover-preview";

/**
 * Builds a YouTube-style hover thumbnail from the playing video.
 * Remux sources are never seeked — that would kick a new pack job.
 * Native sources refine the nearest cached frame with a hidden seek.
 */
export function useHoverPreview(options: {
  videoRef: RefObject<HTMLVideoElement | null>;
  hoverTime: number | null;
  remux: boolean;
  poster?: string | null;
}): { previewSrc: string | null; scoutRef: RefObject<HTMLVideoElement | null> } {
  const { videoRef, hoverTime, remux, poster } = options;
  const framesRef = useRef(new Map<number, string>());
  const orderRef = useRef<number[]>([]);
  const scoutRef = useRef<HTMLVideoElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const remember = (timeS: number, url: string) => {
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sample = () => {
      const url = captureVideoFrame(video);
      if (url) remember(video.currentTime, url);
    };
    video.addEventListener("timeupdate", sample);
    return () => video.removeEventListener("timeupdate", sample);
  }, [videoRef]);

  useEffect(() => {
    if (hoverTime == null) {
      setPreviewSrc(null);
      return;
    }
    const cached = nearestPreviewFrame(framesRef.current, hoverTime);
    setPreviewSrc(cached ?? poster ?? null);
    if (remux) return;

    const scout = scoutRef.current;
    const main = videoRef.current;
    if (!scout || !main?.currentSrc) return;
    if (scout.src !== main.currentSrc) {
      scout.src = main.currentSrc;
    }
    const handle = window.setTimeout(() => {
      try {
        scout.currentTime = hoverTime;
      } catch {
        /* ignore unseekable hover */
      }
    }, 90);
    return () => window.clearTimeout(handle);
  }, [hoverTime, poster, remux, videoRef]);

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
    return () => scout.removeEventListener("seeked", onSeeked);
  }, []);

  return { previewSrc, scoutRef };
}
