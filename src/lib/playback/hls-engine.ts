/**
 * Engine pick for living-room HLS. Isolated so tests can lock Hisense
 * without mounting video-player.
 *
 * Chromium TV (VIDAA) has working hls.js for H.264. MSE rejects HEVC, and
 * mpegurl canPlayType is often empty even when the SoC can decode a remux
 * assigned to <video src>. Native is therefore HEVC-only, never a blanket
 * TV switch.
 */

export interface NativeHlsTvArgs {
  isTv: boolean;
  hevcNeedsNative: boolean;
  codec?: string | null;
  origin?: string;
  compat?: string;
  delivery?: string;
}

function codecToken(codec?: string | null): string {
  return (codec ?? "").trim().toLowerCase();
}

function codecUnknown(codec?: string | null): boolean {
  const token = codecToken(codec);
  return token === "" || token === "unknown";
}

/** True when this row is (or must be treated as) HEVC. */
export function sourceLooksLikeHevc(args: {
  codec?: string | null;
  origin?: string;
  compat?: string;
  delivery?: string;
}): boolean {
  const token = codecToken(args.codec);
  if (token === "hevc") return true;
  if (token === "h264" || token === "av1") return false;
  if (codecUnknown(args.codec) && args.origin === "debrid" && args.compat === "safari") {
    return true;
  }
  // Remux of an untagged release on TV is the Hades path; H.264 remux is
  // already excluded above.
  return args.delivery === "remux" && codecUnknown(args.codec);
}

/**
 * Native <video src> on TV only when MSE cannot carry HEVC AND the active
 * source is HEVC. H.264 Luna/Quasar stay on hls.js.
 */
export function shouldUseNativeHlsOnTv(args: NativeHlsTvArgs): boolean {
  return args.isTv && args.hevcNeedsNative && sourceLooksLikeHevc(args);
}
