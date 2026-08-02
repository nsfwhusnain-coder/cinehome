import type {
  AudioPreference,
  SubtitlePreference,
} from "@/lib/profile-preferences";

export interface SelectableMediaTrack {
  id: number;
  name?: string;
  lang?: string;
  default?: boolean;
  forced?: boolean;
}

export interface AudioTrackSelection {
  preference: AudioPreference;
  originalLanguage?: string | null;
  preferredLanguage?: string | null;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en",
  jpn: "ja",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  ita: "it",
  por: "pt",
  kor: "ko",
  hin: "hi",
  zho: "zh",
  chi: "zh",
  ara: "ar",
  ben: "bn",
  bul: "bg",
  ces: "cs",
  cze: "cs",
  dan: "da",
  dut: "nl",
  nld: "nl",
  ell: "el",
  gre: "el",
  fin: "fi",
  heb: "he",
  hun: "hu",
  ind: "id",
  may: "ms",
  msa: "ms",
  nor: "no",
  pol: "pl",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  swe: "sv",
  tam: "ta",
  tel: "te",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
};

export function normalizeTrackLanguage(value?: string | null): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  const base = normalized.split("-")[0] ?? normalized;
  return LANGUAGE_ALIASES[base] ?? base;
}

function trackText(track: SelectableMediaTrack): string {
  return `${track.lang ?? ""} ${track.name ?? ""}`.toLowerCase();
}

function isLanguage(track: SelectableMediaTrack, language?: string | null): boolean {
  const target = normalizeTrackLanguage(language);
  if (!target) return false;
  const actual = normalizeTrackLanguage(track.lang);
  if (actual === target) return true;
  const name = (track.name ?? "").toLowerCase();
  if (target === "en") return /\b(english|eng)\b/.test(name);
  return name.includes(target);
}

export function isCommentaryOrDescriptionTrack(
  track: SelectableMediaTrack
): boolean {
  return /commentary|audio description|audio described|descriptive audio|director.?s comments|narration/.test(
    trackText(track)
  );
}

function usableAudioTracks(
  tracks: readonly SelectableMediaTrack[]
): readonly SelectableMediaTrack[] {
  const normal = tracks.filter((track) => !isCommentaryOrDescriptionTrack(track));
  return normal.length > 0 ? normal : tracks;
}

function firstLanguageMatch(
  tracks: readonly SelectableMediaTrack[],
  language?: string | null
): SelectableMediaTrack | undefined {
  const matches = tracks.filter((track) => isLanguage(track, language));
  return matches.find((track) => track.default) ?? matches[0];
}

/** Original audio first, then English, without auto-selecting commentary. */
export function selectAudioTrack(
  tracks: readonly SelectableMediaTrack[],
  selection: AudioTrackSelection
): SelectableMediaTrack | null {
  if (tracks.length === 0) return null;
  const usable = usableAudioTracks(tracks);
  const original = selection.originalLanguage;
  const preferred = selection.preferredLanguage;
  const languageOrder =
    selection.preference === "english"
      ? ["en", original, preferred]
      : selection.preference === "preferred"
        ? [preferred, original, "en"]
        : [original, "en", preferred];

  for (const language of languageOrder) {
    const match = firstLanguageMatch(usable, language);
    if (match) return match;
  }
  return usable.find((track) => track.default) ?? usable[0] ?? null;
}

export function isForcedSubtitleTrack(track: SelectableMediaTrack): boolean {
  return Boolean(track.forced) || /\bforced\b/.test(trackText(track));
}

function isAccessibilitySubtitleTrack(track: SelectableMediaTrack): boolean {
  return /\b(sdh|cc)\b|hearing.?impaired|closed captions/.test(trackText(track));
}

/** English full subtitles first; SDH/CC next; forced tracks only as a last resort. */
export function selectSubtitleTrack(
  tracks: readonly SelectableMediaTrack[],
  preference: SubtitlePreference
): SelectableMediaTrack | null {
  if (preference === "off" || tracks.length === 0) return null;
  const english = tracks.filter((track) => isLanguage(track, "en"));
  const full = english.filter(
    (track) =>
      !isForcedSubtitleTrack(track) && !isAccessibilitySubtitleTrack(track)
  );
  const accessibility = english.filter(
    (track) =>
      !isForcedSubtitleTrack(track) && isAccessibilitySubtitleTrack(track)
  );
  const forced = english.filter(isForcedSubtitleTrack);
  return (
    full.find((track) => track.default) ??
    full[0] ??
    accessibility.find((track) => track.default) ??
    accessibility[0] ??
    forced.find((track) => track.default) ??
    forced[0] ??
    null
  );
}
