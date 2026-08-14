import type Hls from "hls.js";
import type { MediaTrack, QualityLevel } from "@/stores/player-store";
import { annotateLevelHeights } from "./hls-quality";

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatAudioTrackLabel(
  track: { name?: string; lang?: string; channels?: string },
  index: number,
  all: Array<{ name?: string; lang?: string }>
): string {
  const lang = (track.lang ?? "").toLowerCase();
  const name = (track.name ?? "").trim();
  let base: string;
  if (lang.startsWith("en") || name.toLowerCase().includes("english")) {
    base = "English";
  } else if (name) {
    base = name;
  } else if (track.lang) {
    base = track.lang.toUpperCase();
  } else {
    base = `Audio ${index + 1}`;
  }

  if (all.length <= 1) return base;

  const langKey = lang || name.toLowerCase() || `idx-${index}`;
  const sameLang = all.filter((t, i) => {
    const k = (t.lang ?? "").toLowerCase() || (t.name ?? "").toLowerCase() || `idx-${i}`;
    return k === langKey;
  });
  if (sameLang.length <= 1) return base;

  const ordinal =
    all
      .map((t, i) => ({ t, i }))
      .filter(({ t, i }) => {
        const k = (t.lang ?? "").toLowerCase() || (t.name ?? "").toLowerCase() || `idx-${i}`;
        return k === langKey;
      })
      .findIndex(({ i }) => i === index) + 1;

  if (name && name.toLowerCase() !== base.toLowerCase() && !name.toLowerCase().includes("english")) {
    return `${base} · ${name}`;
  }
  if (track.channels) {
    return `${base} · ${track.channels} · Track ${ordinal}`;
  }
  return `${base} · Track ${ordinal}`;
}

export function mapAudioTracks(hls: Hls): MediaTrack[] {
  const raw = hls.audioTracks;
  return raw.map((t, i) => ({
    id: typeof t.id === "number" ? t.id : i,
    name: formatAudioTrackLabel(t, i, raw),
    lang: t.lang || undefined,
    channels: t.channels || undefined,
  }));
}

export function mapSubtitleTracks(hls: Hls): MediaTrack[] {
  return hls.subtitleTracks.map((t, i) => ({
    id: typeof t.id === "number" ? t.id : i,
    name: t.name || t.lang || `Subtitle ${i + 1}`,
    lang: t.lang || undefined,
  }));
}

export function mapNativeTextTracks(video: HTMLVideoElement): MediaTrack[] {
  const list = video.textTracks;
  const out: MediaTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    if (t.kind !== "subtitles" && t.kind !== "captions") continue;
    out.push({
      id: i,
      name: t.label || t.language || `Subtitle ${out.length + 1}`,
      lang: t.language || undefined,
    });
  }
  return out;
}

export function mapNativeAudioTracks(video: HTMLVideoElement): MediaTrack[] {
  const media = video as HTMLVideoElement & {
    audioTracks?: {
      length: number;
      [index: number]: { id?: string; label?: string; language?: string; enabled?: boolean };
    };
  };
  const list = media.audioTracks;
  if (!list || list.length === 0) return [];
  const raw: Array<{ name?: string; lang?: string }> = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    raw.push({ name: t.label || undefined, lang: t.language || undefined });
  }
  const out: MediaTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    out.push({
      id: i,
      name: formatAudioTrackLabel(
        { name: t.label || undefined, lang: t.language || undefined },
        i,
        raw
      ),
      lang: t.language || undefined,
    });
  }
  return out;
}

export function mapHlsLevels(
  hls: Hls,
  sourceMaxHeightFallback = 0,
  sourceLadder: ReadonlyArray<number> = []
): QualityLevel[] {
  const raw: QualityLevel[] = hls.levels.map((l, i) => ({
    height: l.height || 0,
    width: l.width || 0,
    index: i,
    bitrate: l.bitrate,
    frameRate: l.frameRate || undefined,
    videoCodec: l.videoCodec || undefined,
    audioCodec: l.audioCodec || undefined,
  }));
  return annotateLevelHeights(raw, sourceLadder, sourceMaxHeightFallback);
}
