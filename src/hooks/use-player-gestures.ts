"use client";

import { useEffect, useRef, useState, useCallback, type RefObject } from "react";

export interface UsePlayerGesturesOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  onSeekRelative: (seconds: number) => void;
  onTogglePlay: () => void;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onToggleSubtitles?: () => void;
  onToggleEpisodes?: () => void;
  onToggleAudioSubtitles?: () => void;
  isTvShow?: boolean;
}

export function usePlayerGestures({
  containerRef,
  videoRef,
  onSeekRelative,
  onTogglePlay,
  onToggleFullscreen,
  onToggleMute,
  onToggleSubtitles,
  onToggleEpisodes,
  onToggleAudioSubtitles,
  isTvShow = false,
}: UsePlayerGesturesOptions) {
  const [ripple, setRipple] = useState<{ side: "left" | "right"; count: number } | null>(null);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [volumeLevel, setVolumeLevel] = useState<number | null>(null);
  const [videoBrightness, setVideoBrightness] = useState<number>(1.0);

  const tapCounterRef = useRef<{ side: "left" | "right"; count: number; lastTime: number }>({
    side: "left",
    count: 0,
    lastTime: 0,
  });

  const hideHudTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; startVal: number; side: "left" | "right" } | null>(null);

  const showHud = useCallback((type: "brightness" | "volume", val: number) => {
    if (hideHudTimerRef.current) clearTimeout(hideHudTimerRef.current);
    if (type === "brightness") {
      setBrightness(val);
      setVolumeLevel(null);
    } else {
      setVolumeLevel(val);
      setBrightness(null);
    }
    hideHudTimerRef.current = setTimeout(() => {
      setBrightness(null);
      setVolumeLevel(null);
    }, 1200);
  }, []);

  // Double tap / double click detection
  const handleTap = useCallback(
    (clientX: number, target: EventTarget | null) => {
      const container = containerRef.current;
      if (!container) return;

      // Ignore interactive controls
      if (
        target instanceof Element &&
        target.closest("button, a, input, select, [role='slider'], [role='dialog'], .player-controls-bottom-row, .player-dock")
      ) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const xRatio = (clientX - rect.left) / rect.width;
      const now = Date.now();

      if (xRatio < 0.35) {
        // Left side double-tap -> seek back
        if (
          tapCounterRef.current.side === "left" &&
          now - tapCounterRef.current.lastTime < 500
        ) {
          const count = tapCounterRef.current.count + 1;
          tapCounterRef.current = { side: "left", count, lastTime: now };
          onSeekRelative(-10);
          setRipple({ side: "left", count });
        } else {
          tapCounterRef.current = { side: "left", count: 1, lastTime: now };
        }
      } else if (xRatio > 0.65) {
        // Right side double-tap -> seek forward
        if (
          tapCounterRef.current.side === "right" &&
          now - tapCounterRef.current.lastTime < 500
        ) {
          const count = tapCounterRef.current.count + 1;
          tapCounterRef.current = { side: "right", count, lastTime: now };
          onSeekRelative(10);
          setRipple({ side: "right", count });
        } else {
          tapCounterRef.current = { side: "right", count: 1, lastTime: now };
        }
      }
    },
    [containerRef, onSeekRelative]
  );

  // Touch gesture handlers for Brightness (Left) and Volume (Right)
  const onTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const container = containerRef.current;
      if (!container) return;

      if (
        e.target instanceof Element &&
        e.target.closest("button, a, input, select, [role='slider'], [role='dialog'], .player-controls-bottom-row")
      ) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const xRatio = (touch.clientX - rect.left) / rect.width;
      const side = xRatio < 0.5 ? "left" : "right";
      const startVal =
        side === "left" ? videoBrightness : videoRef.current?.volume ?? 1.0;

      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        startVal,
        side,
      };

      handleTap(touch.clientX, e.target);
    },
    [containerRef, handleTap, videoBrightness, videoRef]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (!touchStartRef.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaY = touchStartRef.current.y - touch.clientY; // positive = swipe up
      if (Math.abs(deltaY) < 15) return; // small threshold

      const container = containerRef.current;
      if (!container) return;
      const height = container.clientHeight || 400;
      const step = deltaY / (height * 0.75); // normalize drag distance

      if (touchStartRef.current.side === "left") {
        // Brightness: 0.3 to 1.5
        const next = Math.min(1.5, Math.max(0.3, touchStartRef.current.startVal + step * 1.2));
        setVideoBrightness(next);
        showHud("brightness", next);
      } else {
        // Volume: 0 to 1.0
        const video = videoRef.current;
        if (video) {
          const next = Math.min(1.0, Math.max(0.0, touchStartRef.current.startVal + step));
          video.volume = next;
          video.muted = next === 0;
          showHud("volume", next);
        }
      }
    },
    [containerRef, showHud, videoRef]
  );

  const onTouchEnd = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  // Keyboard navigation & hotkeys
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when user is typing in an input / textarea
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLSelectElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      switch (key) {
        case " ":
        case "k":
          e.preventDefault();
          onTogglePlay();
          break;
        case "f":
          e.preventDefault();
          onToggleFullscreen();
          break;
        case "m":
          e.preventDefault();
          onToggleMute();
          break;
        case "c":
          e.preventDefault();
          onToggleSubtitles?.();
          break;
        case "j":
        case "arrowleft":
          e.preventDefault();
          onSeekRelative(e.shiftKey ? -30 : -10);
          setRipple({ side: "left", count: e.shiftKey ? 3 : 1 });
          break;
        case "l":
        case "arrowright":
          e.preventDefault();
          onSeekRelative(e.shiftKey ? 30 : 10);
          setRipple({ side: "right", count: e.shiftKey ? 3 : 1 });
          break;
        case "arrowup": {
          e.preventDefault();
          const video = videoRef.current;
          if (video) {
            const next = Math.min(1.0, video.volume + 0.05);
            video.volume = next;
            video.muted = false;
            showHud("volume", next);
          }
          break;
        }
        case "arrowdown": {
          e.preventDefault();
          const video = videoRef.current;
          if (video) {
            const next = Math.max(0.0, video.volume - 0.05);
            video.volume = next;
            video.muted = next === 0;
            showHud("volume", next);
          }
          break;
        }
        case "e":
          if (isTvShow && onToggleEpisodes) {
            e.preventDefault();
            onToggleEpisodes();
          }
          break;
        case "s":
          if (onToggleAudioSubtitles) {
            e.preventDefault();
            onToggleAudioSubtitles();
          }
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    isTvShow,
    onSeekRelative,
    onToggleAudioSubtitles,
    onToggleEpisodes,
    onToggleFullscreen,
    onToggleMute,
    onTogglePlay,
    onToggleSubtitles,
    showHud,
    videoRef,
  ]);

  return {
    ripple,
    brightness,
    volumeLevel,
    videoBrightness,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    handleDoubleTap: handleTap,
  };
}
