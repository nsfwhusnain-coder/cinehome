/** Hover-scrub preview helpers. Frames are stored on 2s buckets. */

export const PREVIEW_BUCKET_S = 2;
export const PREVIEW_MAX_FRAMES = 150;
export const PREVIEW_NEAR_S = 8;

export function previewBucket(timeS: number, step = PREVIEW_BUCKET_S): number {
  if (!Number.isFinite(timeS) || timeS < 0) return 0;
  return Math.round(timeS / step) * step;
}

export function nearestPreviewFrame(
  frames: ReadonlyMap<number, string>,
  timeS: number,
  maxDistanceS = PREVIEW_NEAR_S
): string | null {
  if (frames.size === 0) return null;
  const want = previewBucket(timeS);
  const exact = frames.get(want);
  if (exact) return exact;
  let bestKey = -1;
  let bestDist = Infinity;
  for (const key of frames.keys()) {
    const dist = Math.abs(key - want);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = key;
    }
  }
  if (bestKey < 0 || bestDist > maxDistanceS) return null;
  return frames.get(bestKey) ?? null;
}

let previewCanvas: HTMLCanvasElement | null = null;

function getPreviewCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!previewCanvas) previewCanvas = document.createElement("canvas");
  return previewCanvas;
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  width = 192
): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  const canvas = getPreviewCanvas();
  if (!canvas) return null;
  const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}
