"use client";

import { useEffect, useRef, useState, useCallback, type RefObject } from "react";

export interface UsePlayerGesturesOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  onSeekRelative: (seconds: number) => void;
}

export function usePlayerGestures({
  containerRef,
  videoRef,
  onSeekRelative,
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

  // Keyboard shortcuts deliberately live in video-player.tsx, NOT here.
  //
  // This hook used to attach a SECOND capture-phase window keydown listener
  // handling the same keys as the player's own handler, so every shortcut ran
  // twice: Space toggled play then immediately paused again (the reported
  // "space does nothing, but the button works" bug), arrows seeked 20s instead
  // of 10, and f/m cancelled themselves out. Clicking a control fired once and
  // therefore always worked, which is what made it look like a shortcut-only
  // problem. One owner only — this hook keeps touch/pointer gestures.

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
