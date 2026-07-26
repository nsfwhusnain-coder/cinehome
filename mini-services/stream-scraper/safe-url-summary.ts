export type StreamPathKind = "hls" | "dash" | "mp4" | "media" | "unknown";

export interface SafeStreamTarget {
  host: string | null;
  pathKind: StreamPathKind;
}

/**
 * Summarize a media target for metrics without retaining its path, query,
 * signed token, or user credential.
 */
export function safeStreamTarget(rawUrl: string | null | undefined): SafeStreamTarget {
  if (!rawUrl) return { host: null, pathKind: "unknown" };
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    const pathKind: StreamPathKind =
      path.endsWith(".m3u8") || path.includes("playlist")
        ? "hls"
        : path.endsWith(".mpd")
          ? "dash"
          : path.endsWith(".mp4") || path.endsWith(".m4v")
            ? "mp4"
            : /\.(?:m4s|ts|m2ts|webm|mov)$/.test(path)
              ? "media"
              : "unknown";
    return { host: parsed.hostname || null, pathKind };
  } catch {
    return { host: null, pathKind: "unknown" };
  }
}
