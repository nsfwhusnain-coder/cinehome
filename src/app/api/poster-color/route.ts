import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getAuthenticatedUserId } from "@/lib/auth";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w92";
const VALID_PATH = /^\/[a-zA-Z0-9]+\.(jpg|jpeg|png)$/;

/** Ambient is always a dark hue of the artwork — never the bright color. */
const MAX_SATURATION = 0.45;
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.2;
const MAX_REL_LUMINANCE = 0.05;
const FALLBACK_HEX = "#0a0a0f";

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

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Average → HSL, clamp S ≤ 45% and L 12–20%. Too bright → canvas.
function darkenTint(r: number, g: number, b: number): [number, number, number] | null {
  const [h, s, l] = rgbToHsl(r, g, b);
  const clampedS = Math.min(s, MAX_SATURATION);
  const clampedL = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l));
  const rgb = hslToRgb(h, clampedS, clampedL);
  if (relativeLuminance(rgb[0], rgb[1], rgb[2]) > MAX_REL_LUMINANCE) return null;
  return rgb;
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path || !VALID_PATH.test(path)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${TMDB_IMAGE_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const { data } = await sharp(buffer)
      .resize(1, 1, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tinted = darkenTint(data[0], data[1], data[2]);
    const color = tinted ? toHex(tinted) : FALLBACK_HEX;

    return NextResponse.json(
      { color },
      { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=2592000" } }
    );
  } catch {
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}
