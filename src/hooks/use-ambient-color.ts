"use client";

import { useEffect } from "react";
import { tmdbImageUrl } from "@/lib/tmdb";
import { useAmbientStore } from "@/stores/ambient-store";

const FALLBACK = "#0a0a0f";
/** Ambient is always a dark hue — never the bright artwork color. */
const MAX_SATURATION = 0.45;
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.2;
/** WCAG relative luminance ceiling — above this, fall back to canvas. */
const MAX_REL_LUMINANCE = 0.05;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number] = [0, 0, 0];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Force ambient to a dark tinted hue of the artwork.
 * S ≤ 45%, L 12–20%. If still too bright (rel-lum > 0.05) → canvas.
 */
function clampAmbientTint(r: number, g: number, b: number): string {
  try {
    const [hh, ss, ll] = rgbToHsl(r, g, b);
    const s = Math.min(ss, MAX_SATURATION);
    const l = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, ll));
    const [rr, gg, bb] = hslToRgb(hh, s, l);
    if (relativeLuminance(rr, gg, bb) > MAX_REL_LUMINANCE) return FALLBACK;
    return toHex(rr, gg, bb);
  } catch {
    return FALLBACK;
  }
}

/** Re-clamp a hex from API/canvas so both usage sites never see a bright wash. */
function forceClampHex(hex: string | null | undefined): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return FALLBACK;
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return clampAmbientTint(r, g, b);
  } catch {
    return FALLBACK;
  }
}

/** Canvas average @ ~16×9 → dark ambient clamp. Failures → null. */
async function extractTintCanvas(imageUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const w = 16;
        const h = 9;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
        if (n === 0) {
          resolve(null);
          return;
        }
        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);
        resolve(clampAmbientTint(r, g, b));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

/** Server-side extract (CORS-safe); re-clamped client-side before store. */
async function extractTintApi(imagePath: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/poster-color?path=${encodeURIComponent(imagePath)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { color?: string };
    return json.color || null;
  } catch {
    return null;
  }
}

/**
 * Dominant dark ambient tint for hero scrim final stop + below-hero flow.
 * Always dark (S≤45%, L 12–20%); never a bright cream/sky wash.
 */
export function useAmbientColor(imagePath: string | null | undefined) {
  const setColor = useAmbientStore((s) => s.setColor);

  useEffect(() => {
    if (!imagePath) {
      setColor(FALLBACK);
      return;
    }
    let cancelled = false;

    void (async () => {
      const url = tmdbImageUrl(imagePath, "w300");
      let tint: string | null = null;
      if (url) tint = await extractTintCanvas(url);
      if (!tint) tint = await extractTintApi(imagePath);
      // Force-clamp once before either usage site reads the store.
      if (!cancelled) setColor(forceClampHex(tint));
    })();

    return () => {
      cancelled = true;
    };
  }, [imagePath, setColor]);

  useEffect(() => {
    return () => setColor(FALLBACK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
