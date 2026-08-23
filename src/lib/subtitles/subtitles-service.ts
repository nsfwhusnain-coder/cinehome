import gzip from "node:zlib";

export interface SubtitleTrackOption {
  id: string;
  label: string;
  language: string;
  subLanguageId: string;
  format: string;
  downloadUrl: string;
  vttUrl: string;
  isDefault?: boolean;
}

// In-memory 24h subtitle metadata cache
const subtitleCache = new Map<string, { timestamp: number; tracks: SubtitleTrackOption[] }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Language code to human friendly display names
const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  en: "English",
  spa: "Spanish",
  es: "Spanish",
  fre: "French",
  fra: "French",
  fr: "French",
  ger: "German",
  deu: "German",
  de: "German",
  por: "Portuguese",
  pob: "Portuguese (BR)",
  pt: "Portuguese",
  ita: "Italian",
  it: "Italian",
  rus: "Russian",
  ru: "Russian",
  ara: "Arabic",
  ar: "Arabic",
  jpn: "Japanese",
  ja: "Japanese",
  kor: "Korean",
  ko: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  zh: "Chinese",
  hin: "Hindi",
  hi: "Hindi",
  tur: "Turkish",
  tr: "Turkish",
  vie: "Vietnamese",
  vi: "Vietnamese",
  pol: "Polish",
  pl: "Polish",
  dut: "Dutch",
  nld: "Dutch",
  nl: "Dutch",
  swe: "Swedish",
  sv: "Swedish",
  nor: "Norwegian",
  no: "Norwegian",
  dan: "Danish",
  da: "Danish",
  fin: "Finnish",
  fi: "Finnish",
  gre: "Greek",
  ell: "Greek",
  el: "Greek",
  heb: "Hebrew",
  he: "Hebrew",
  ind: "Indonesian",
  id: "Indonesian",
  tha: "Thai",
  th: "Thai",
};

export function getLanguageDisplayName(code: string, rawName?: string): string {
  const normalized = (code || "").trim().toLowerCase();
  if (LANGUAGE_NAMES[normalized]) return LANGUAGE_NAMES[normalized];
  if (rawName && rawName.trim()) return rawName.trim();
  return normalized.toUpperCase() || "Unknown";
}

/**
 * Converts raw SubRip (SRT) string into clean standard WebVTT format.
 * Strips HTML ads/watermarks and normalizes timestamp formats.
 */
export function convertSrtToVtt(srtContent: string): string {
  if (!srtContent || !srtContent.trim()) return "WEBVTT\n\n";

  // Normalize newlines
  const text = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Regex to match timestamp lines: 00:00:20,000 --> 00:00:24,400
  const timestampRegex = /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/;

  const lines = text.split("\n");
  const output: string[] = ["WEBVTT", ""];

  let inCue = false;
  let currentCueText: string[] = [];
  let currentTimestamp = "";

  const isAdLine = (line: string): boolean => {
    const lower = line.toLowerCase();
    return (
      lower.includes("opensubtitles") ||
      lower.includes("osdb.link") ||
      lower.includes("subtitles by") ||
      lower.includes("downloaded from") ||
      lower.includes("watch online") ||
      lower.includes("sync and corrections") ||
      lower.includes("advertisement") ||
      lower.includes("captioned by") ||
      lower.includes("addic7ed.com") ||
      lower.includes("yify-subtitles")
    );
  };

  const flushCue = () => {
    if (currentTimestamp && currentCueText.length > 0) {
      // Filter out promotional / spam text
      const cleanLines = currentCueText.filter((line) => !isAdLine(line));

      if (cleanLines.length > 0) {
        output.push(currentTimestamp);
        output.push(cleanLines.join("\n"));
        output.push("");
      }
    }
    currentCueText = [];
    currentTimestamp = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inCue) {
        flushCue();
        inCue = false;
      }
      continue;
    }

    // Check if line is timestamp
    const tsMatch = trimmed.match(timestampRegex);
    if (tsMatch) {
      flushCue();
      inCue = true;
      // Convert comma to dot: 00:00:20.000 --> 00:00:24.400
      currentTimestamp = `${tsMatch[1]}.${tsMatch[2]} --> ${tsMatch[3]}.${tsMatch[4]}`;
      continue;
    }

    // Skip numeric sequence identifiers
    if (/^\d+$/.test(trimmed) && !inCue) {
      continue;
    }

    if (inCue) {
      currentCueText.push(trimmed);
    }
  }

  flushCue();
  return output.join("\n");
}

/**
 * Resolves TMDB ID to IMDb ID via TMDB API.
 */
export async function getImdbIdFromTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  tmdbApiKey?: string
): Promise<string | null> {
  const apiKey = tmdbApiKey || process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const endpoint =
      mediaType === "tv"
        ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${apiKey}`
        : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${apiKey}`;

    const res = await fetch(endpoint, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

/**
 * Searches and fetches subtitles for a title from OpenSubtitles.
 */
export async function fetchSubtitlesForTitle(options: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  imdbId?: string | null;
  season?: number;
  episode?: number;
  preferredLanguage?: string;
}): Promise<SubtitleTrackOption[]> {
  const { tmdbId, mediaType, season, episode } = options;
  const cacheKey = `${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`;

  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.tracks;
  }

  let imdbId = options.imdbId;
  if (!imdbId) {
    imdbId = await getImdbIdFromTmdb(tmdbId, mediaType);
  }

  if (!imdbId) {
    return [];
  }

  const numericImdb = imdbId.replace(/^tt/, "");
  let queryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericImdb}`;
  if (mediaType === "tv" && season != null && episode != null) {
    queryUrl += `/season-${season}/episode-${episode}`;
  }

  try {
    const res = await fetch(queryUrl, {
      headers: {
        "User-Agent": "CinehomeStream/2.0",
        "X-User-Agent": "CinehomeStream/2.0",
      },
    });

    if (!res.ok) {
      return [];
    }

    const items = (await res.json()) as Array<{
      IDSubtitleFile: string;
      SubFileName: string;
      SubLanguageID: string;
      LanguageName: string;
      SubFormat: string;
      SubDownloadLink: string;
      SubEncoding?: string;
    }>;

    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    // Group and pick highest quality / distinct subtitle per language
    const tracksByLang = new Map<string, SubtitleTrackOption>();
    const seenFiles = new Set<string>();

    for (const item of items) {
      if (!item.SubDownloadLink || seenFiles.has(item.IDSubtitleFile)) continue;
      seenFiles.add(item.IDSubtitleFile);

      const langCode = (item.SubLanguageID || "eng").toLowerCase();
      const langName = getLanguageDisplayName(langCode, item.LanguageName);

      // Keep up to 3 variants per language (e.g. English, English (SDH), English (CC))
      const count = [...tracksByLang.keys()].filter((k) => k.startsWith(langCode)).length;
      if (count >= 3) continue;

      const suffix = count === 0 ? "" : ` [${count + 1}]`;
      const key = `${langCode}${suffix}`;

      const vttUrl = `/api/subtitles/vtt?url=${encodeURIComponent(item.SubDownloadLink)}&id=${item.IDSubtitleFile}`;

      tracksByLang.set(key, {
        id: `sub_${item.IDSubtitleFile}`,
        label: `${langName}${suffix}`,
        language: langCode === "pob" ? "pt-BR" : langCode,
        subLanguageId: langCode,
        format: item.SubFormat || "srt",
        downloadUrl: item.SubDownloadLink,
        vttUrl,
        isDefault: langCode === "eng" || langCode === "en",
      });
    }

    // Sort English and common languages first
    const tracks = [...tracksByLang.values()].sort((a, b) => {
      if (a.language.startsWith("en") && !b.language.startsWith("en")) return -1;
      if (!a.language.startsWith("en") && b.language.startsWith("en")) return 1;
      if (a.language.startsWith("es") && !b.language.startsWith("es")) return -1;
      if (!a.language.startsWith("es") && b.language.startsWith("es")) return 1;
      return a.label.localeCompare(b.label);
    });

    subtitleCache.set(cacheKey, { timestamp: Date.now(), tracks });
    return tracks;
  } catch (err) {
    console.error("[subtitles] failed to fetch subtitles:", err);
    return [];
  }
}

/**
 * Downloads .gz subtitle archive and converts it to WebVTT.
 */
export async function downloadAndConvertVtt(downloadUrl: string): Promise<string | null> {
  try {
    const res = await fetch(downloadUrl, {
      headers: {
        "User-Agent": "CinehomeStream/2.0",
      },
    });

    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    let rawText = "";

    // Check if gzipped
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      const decompressed = gzip.gunzipSync(buffer);
      rawText = decompressed.toString("utf-8");
    } else {
      rawText = buffer.toString("utf-8");
    }

    return convertSrtToVtt(rawText);
  } catch (err) {
    console.error("[subtitles] failed to download/convert VTT:", err);
    return null;
  }
}
