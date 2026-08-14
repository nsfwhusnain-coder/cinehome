import type { IdentityEvidence, PlaybackSource } from "./types";

/**
 * Provider-stamped identity. Label regex is a fallback only — CinemaOS and
 * Vidrock already know the language; debrid already knows the release title.
 */

const FOREIGN_AUDIO_NAME =
  /\b(hindi|arabic|french|spanish|german|portuguese|tamil|telugu|malayalam|bengali|italian|russian|turkish|indonesian|thai|vietnamese|dutch|polish|urdu|punjabi|marathi|kannada|mandarin|cantonese|korean|japanese|hebrew|persian|farsi)\b/i;
const FOREIGN_CINEMA_CODE =
  /\bcinema[ ._-]?(hi|ar|fr|es|de|pt|ta|te|ml|bn|it|ru|tr|id|th|vi|nl|pl|ur|pa|mr|kn|zh|ko|ja|he|fa)\b/i;
const ENGLISH_AUDIO_NAME =
  /\benglish\b|\bcinema en\b|\bcinema-en\b|\(en\)/i;
const CINEMA_XX = /\bcinema[ ._-]?xx\b/i;
const PACK_NAME =
  /\b(?:season[ ._-]?\d+|s\d{1,2}|complete[ ._-]?(?:series|season|pack)|collection|filmography|duology|trilogy)\b/i;

const NAME_TO_CODE: Readonly<Record<string, string>> = {
  english: "en",
  hindi: "hi",
  arabic: "ar",
  french: "fr",
  spanish: "es",
  german: "de",
  portuguese: "pt",
  tamil: "ta",
  telugu: "te",
  malayalam: "ml",
  bengali: "bn",
  italian: "it",
  russian: "ru",
  turkish: "tr",
  indonesian: "id",
  thai: "th",
  vietnamese: "vi",
  dutch: "nl",
  polish: "pl",
  urdu: "ur",
  punjabi: "pa",
  marathi: "mr",
  kannada: "kn",
  mandarin: "zh",
  cantonese: "zh",
  chinese: "zh",
  korean: "ko",
  japanese: "ja",
  hebrew: "he",
  persian: "fa",
  farsi: "fa",
};

export type TitleMatch = NonNullable<PlaybackSource["titleMatch"]>;

export function normalizeAudioLanguageCode(raw: string | undefined | null): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "";
  if (value === "eng" || value === "en-us" || value === "en-gb") return "en";
  if (value === "english") return "en";
  if (value === "und" || value === "unknown") return "und";
  if (value === "xx") return "xx";
  if (NAME_TO_CODE[value]) return NAME_TO_CODE[value];
  const two = value.slice(0, 2);
  if (/^[a-z]{2}$/.test(two)) return two;
  return value.slice(0, 3);
}

/** Infer a language code from provider/label text when the row was not stamped. */
export function inferAudioLanguageFromText(text: string): string {
  const raw = text.trim();
  if (!raw) return "und";
  if (ENGLISH_AUDIO_NAME.test(raw)) return "en";
  if (CINEMA_XX.test(raw)) return "xx";
  const cinema = raw.match(
    /\bcinema[ ._-]?(hi|ar|fr|es|de|pt|ta|te|ml|bn|it|ru|tr|id|th|vi|nl|pl|ur|pa|mr|kn|zh|ko|ja|he|fa|xx)\b/i
  );
  if (cinema?.[1]) return cinema[1].toLowerCase() === "xx" ? "xx" : cinema[1].toLowerCase();
  if (FOREIGN_CINEMA_CODE.test(raw) || FOREIGN_AUDIO_NAME.test(raw)) {
    for (const [name, code] of Object.entries(NAME_TO_CODE)) {
      if (name === "english") continue;
      if (new RegExp(`\\b${name}\\b`, "i").test(raw)) return code;
    }
    return "xx";
  }
  return "und";
}

export function sourceAudioLanguageCode(source: PlaybackSource): string {
  const stamped = normalizeAudioLanguageCode(source.audioLanguage);
  if (stamped) return stamped === "eng" ? "en" : stamped;
  return inferAudioLanguageFromText(`${source.label} ${source.provider}`);
}

/**
 * 2 = English / unlabeled. 1 = unknown locale or anime original.
 * 0 = explicit foreign. Anime JA/KO is 1 so English still wins when both exist.
 */
export function sourceAudioLanguageRank(
  source: PlaybackSource,
  contentClass?: string | null
): number {
  const code = sourceAudioLanguageCode(source);
  if (code === "en" || code === "und") return 2;
  if (code === "xx") return 1;
  if (contentClass === "anime" && (code === "ja" || code === "ko")) return 1;
  return 0;
}

export function isEnglishPreferredSource(
  source: PlaybackSource,
  contentClass?: string | null
): boolean {
  return sourceAudioLanguageRank(source, contentClass) >= 2;
}

export function inferTitleMatchFromText(text: string): TitleMatch {
  return PACK_NAME.test(text) ? "pack" : "unknown";
}

export function sourceTitleMatch(source: PlaybackSource): TitleMatch {
  if (source.titleMatch) return source.titleMatch;
  if (source.origin === "debrid") return "exact";
  return inferTitleMatchFromText(`${source.label} ${source.provider}`);
}

export function isPackSource(source: PlaybackSource): boolean {
  return sourceTitleMatch(source) === "pack";
}

export function defaultIdentityEvidence(
  source: Pick<PlaybackSource, "origin" | "identityEvidence">
): IdentityEvidence {
  if (source.identityEvidence) return source.identityEvidence;
  return source.origin === "debrid" ? "release_title" : "exact_media_route";
}

export function withInferredSourceFacts(source: PlaybackSource): PlaybackSource {
  const audioLanguage = source.audioLanguage
    ? normalizeAudioLanguageCode(source.audioLanguage) || source.audioLanguage
    : inferAudioLanguageFromText(`${source.label} ${source.provider}`);
  const titleMatch = source.titleMatch ?? inferTitleMatchFromText(`${source.label} ${source.provider}`);
  const identityEvidence = defaultIdentityEvidence(source);
  if (
    source.audioLanguage === audioLanguage &&
    source.titleMatch === titleMatch &&
    source.identityEvidence === identityEvidence
  ) {
    return source;
  }
  return { ...source, audioLanguage, titleMatch, identityEvidence };
}
