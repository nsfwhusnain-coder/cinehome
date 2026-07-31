import { create } from "zustand";

export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const VOLUME_KEY = "cinehome:player-volume";
const MUTED_KEY = "cinehome:player-muted";

function readStoredVolume(): number {
  if (typeof window === "undefined") return 1;
  const raw = window.localStorage.getItem(VOLUME_KEY);
  const n = raw != null ? Number(raw) : 1;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

function readStoredMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MUTED_KEY) === "1";
}

function writeStoredVolume(v: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VOLUME_KEY, String(v));
}

function writeStoredMuted(v: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MUTED_KEY, v ? "1" : "0");
}

export interface QualityLevel {
  height: number;
  width?: number;
  index: number;
  bitrate?: number;
}

export interface MediaTrack {
  id: number;
  name: string;
  lang?: string;
  channels?: string;
}

interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  /**
   * True while `duration` is still growing. A remux is produced live, so its
   * playlist reports how much has been REMUXED, not how long the title is —
   * anything dividing by duration (resume progress, the end-of-episode card)
   * must wait. Set from hls.js level details; false for ordinary VOD sources.
   */
  durationProvisional: boolean;
  buffering: boolean;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  isPip: boolean;
  showControls: boolean;
  quality: number; // HLS level index, -1 = auto (selected preference)
  /** Actual currently-decoding height from hls LEVEL_SWITCHED (0 = unknown). */
  playingHeight: number;
  levels: QualityLevel[];
  /** Buffered-ahead edge (seconds); lives here (not top-level VideoPlayer state) so the
   * 4x/sec updates only re-render whichever component actually subscribes to it. */
  bufferedEnd: number;
  speed: number;
  subtitlesOn: boolean;
  error: string | null;

  subtitleTracks: MediaTrack[];
  audioTracks: MediaTrack[];
  activeSubtitleId: number | null; // null = off
  activeAudioId: number;
  serverDisplayName: string;

  setIsPlaying: (v: boolean) => void;
  setCurrentTime: (v: number) => void;
  setDuration: (v: number) => void;
  setBuffering: (v: boolean) => void;
  setVolume: (v: number) => void;
  setIsMuted: (v: boolean) => void;
  setIsFullscreen: (v: boolean) => void;
  setIsPip: (v: boolean) => void;
  setShowControls: (v: boolean) => void;
  setQuality: (v: number) => void;
  setPlayingHeight: (v: number) => void;
  setLevels: (v: QualityLevel[]) => void;
  setBufferedEnd: (v: number) => void;
  setSpeed: (v: number) => void;
  setSubtitlesOn: (v: boolean) => void;
  setError: (v: string | null) => void;
  setSubtitleTracks: (v: MediaTrack[]) => void;
  setAudioTracks: (v: MediaTrack[]) => void;
  setActiveSubtitleId: (v: number | null) => void;
  setActiveAudioId: (v: number) => void;
  setServerDisplayName: (v: string) => void;
  reset: () => void;
  resetStream: () => void;
  setDurationProvisional: (v: boolean) => void;
}

const initialState = {
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  durationProvisional: false,
  buffering: true,
  volume: readStoredVolume(),
  isMuted: readStoredMuted(),
  isFullscreen: false,
  isPip: false,
  showControls: true,
  quality: -1,
  playingHeight: 0,
  levels: [] as QualityLevel[],
  bufferedEnd: 0,
  speed: 1,
  subtitlesOn: false,
  error: null as string | null,
  subtitleTracks: [] as MediaTrack[],
  audioTracks: [] as MediaTrack[],
  activeSubtitleId: null as number | null,
  activeAudioId: 0,
  serverDisplayName: "Stream",
};

export const usePlayerStore = create<PlayerState>((set) => ({
  ...initialState,
  setIsPlaying: (v) => set({ isPlaying: v }),
  setCurrentTime: (v) => set({ currentTime: v }),
  setDuration: (v) => set({ duration: v }),
  setDurationProvisional: (v) => set({ durationProvisional: v }),
  setBuffering: (v) => set({ buffering: v }),
  setVolume: (v) => {
    writeStoredVolume(v);
    set({ volume: v });
  },
  setIsMuted: (v) => {
    writeStoredMuted(v);
    set({ isMuted: v });
  },
  setIsFullscreen: (v) => set({ isFullscreen: v }),
  setIsPip: (v) => set({ isPip: v }),
  setShowControls: (v) => set({ showControls: v }),
  setQuality: (v) => set({ quality: v }),
  setPlayingHeight: (v) => set({ playingHeight: v }),
  setLevels: (v) => set({ levels: v }),
  setBufferedEnd: (v) => set({ bufferedEnd: v }),
  setSpeed: (v) => set({ speed: v }),
  setSubtitlesOn: (v) => set({ subtitlesOn: v }),
  setError: (v) => set({ error: v }),
  setSubtitleTracks: (v) => set({ subtitleTracks: v }),
  setAudioTracks: (v) => set({ audioTracks: v }),
  setActiveSubtitleId: (v) => set({ activeSubtitleId: v }),
  setActiveAudioId: (v) => set({ activeAudioId: v }),
  setServerDisplayName: (v) => set({ serverDisplayName: v }),
  reset: () => set(initialState),
  resetStream: () =>
    set({
      buffering: true,
      durationProvisional: false,
      error: null,
      quality: -1,
      playingHeight: 0,
      levels: [],
      bufferedEnd: 0,
      subtitleTracks: [],
      audioTracks: [],
      activeSubtitleId: null,
      activeAudioId: 0,
      // Avoid sticky "subs on" chrome across source switches with zero tracks (PR-10).
      subtitlesOn: false,
    }),
}));
