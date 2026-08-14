/**
 * Torrentio index client for the PREMIUM debrid tier.
 *
 * Torrentio is keyed by IMDb id, not TMDB id — callers must resolve imdb id
 * first (see `resolveImdbId`). We always request Torrentio with the owner's
 * Real-Debrid token baked into the path's config segment
 * (`/realdebrid=<token>/stream/...`) so Torrentio itself does the
 * add/select/cache-check server-side and only ever surfaces INSTANT (cached)
 * results — the deprecated `/torrents/instantAvailability` RD endpoint is
 * never used (see realdebrid.ts for why).
 *
 * Real fetch, bounded timeout, never throws — callers get `[]` on any failure
 * (network, malformed JSON, TMDB miss) so a Torrentio outage never breaks the
 * existing embed roster.
 *
 * CANDIDATE SELECTION — a popular title's RD-configured Torrentio response
 * typically has 150-224 fully cached streams, but they skew heavily toward
 * 4K HEVC/HDR remuxes (often MKV): a flat "top 8 by resolution" truncation
 * (the old behavior) can miss every browser-safe H.264 release entirely, even
 * though 14-37 usually exist per title. So candidates are now: parsed,
 * bucketed by compatibility and resolution, ranked within each class by a
 * media-type-aware, monotonically increasing size richness plus bounded
 * seeders and container confidence, then capped PER CLASS (`PER_CLASS_CAP`)
 * so the returned pool always has representation across classes instead of
 * being dominated by whichever class happens to have the most raw entries.
 * Native 720p is kept only as an availability fallback when no higher native
 * release survives.
 *
 * CONTAINER — MKV/WebM candidates are kept in the resolved inventory. No
 * browser opens them directly (see `isBrowserPlayableContainer`), but they are
 * no longer dead: the app remuxes them to fMP4 with a stream copy, which
 * preserves resolution and codec, so a 4K MKV plays at 4K. `container` and
 * `codec` are carried to the client, where `sourceDelivery` turns them into
 * direct / remux / unavailable. Container therefore affects DELIVERY COST
 * only; the codec is what decides which browsers can play a release at all,
 * and it alone drives `compat`.
 */
import { tmdb } from "@/lib/tmdb";
import type { MediaType } from "../types";
import { isCaptureRelease, releaseQualityScore } from "../release-scorer";
import { tvQueryIndex } from "../tv-index";

const TORRENTIO_BASE = (process.env.TORRENTIO_BASE || "https://torrentio.strem.fun").replace(
  /\/+$/,
  ""
);
const TORRENTIO_TIMEOUT_MS = 8_000;

export type ReleaseCodec = "h264" | "hevc" | "av1" | "unknown";
export type ReleaseContainer = "mp4" | "mkv" | "webm" | "mov" | "unknown";
export type ReleaseCompat = "native" | "safari";
export type ReleaseAudioCodec =
  | "aac"
  | "ac3"
  | "eac3"
  | "dts"
  | "truehd"
  | "flac"
  | "opus"
  | "mp3"
  | "unknown";

export interface ParsedRelease {
  /** 2160, 1080, some lower value, or null when no resolution token was found. */
  resolutionHeight: number | null;
  codec: ReleaseCodec;
  audioCodec: ReleaseAudioCodec;
  multiAudio: boolean;
  hdr: boolean;
  container: ReleaseContainer;
  /**
   * "native" = plays in any Chromium/Firefox browser: H.264 progressive
   * MP4/MOV with no HDR, OR AV1-in-MP4/MOV (AV1 has been Chrome/Firefox-
   * native for years; it is NOT reliably Safari-playable — Safari's AV1
   * support is recent/partial and absent on iOS entirely as of this
   * writing, the opposite situation from HEVC). "safari" = HEVC, HDR/DV, or
   * MKV/WebM — Chrome typically can't decode/demux this; only Safari
   * (AVFoundation) reliably can for the MP4/MOV cases.
   *
   * NOTE (honesty caveat): this value is ALSO set to "safari" for MKV/WebM
   * releases purely for backward-compat with the sibling TorBox tier's own
   * file-eligibility heuristic (torbox.ts calls `parseReleaseTitle` directly
   * on actual resolved filenames) — but MKV is NOT actually Safari-playable;
   * no browser, including Safari, can play the MKV container. Any caller
   * that surfaces a source straight to a `<video>` tag (this module's own
   * `isBrowserPlayableContainer`, consumed by source-quality.ts's
   * `isSourcePlayableHere`) MUST check `container` separately — a MKV/WebM
   * release is never "playable somewhere" in the native sense and is
   * production-unavailable while the legacy transcoder is disabled. Conversely, a
   * caller that cares about AV1-on-old-Safari specifically should gate on
   * `codec === "av1"` itself (a browser/version capability check) rather
   * than assuming `compat === "native"` means every engine can decode it —
   * this field only encodes the Chrome/Firefox-vs-Safari split, not every
   * individual browser/version's real decode matrix.
   */
  compat: ReleaseCompat;
}

export interface DebridCandidate extends ParsedRelease {
  /** First line of the release title/name (drop the seeders/size/source footer Torrentio appends). */
  title: string;
  /**
   * 4K/1080p are the preferred premium rungs. Native 720p is retained only
   * as an availability fallback when no browser-playable higher rung exists.
   */
  resolutionHeight: 720 | 1080 | 2160;
  infoHash?: string;
  /** 0-based file index within the torrent (Stremio addon protocol convention). */
  fileIdx?: number;
  /** Already resolved to a direct-playable link by the RD-configured Torrentio index (path 2a). */
  url?: string;
  /** Parsed from Torrentio's "👤 N" seeders footer — 0 when absent. Real-world demand/health signal used for in-class ranking. */
  seeders: number;
  /** Selected file size from Torrentio's footer, when present. */
  sizeBytes?: number;
}

interface TorrentioStreamRaw {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  url?: string;
  behaviorHints?: { filename?: string; bingeGroup?: string };
}

interface TorrentioResponseRaw {
  streams?: TorrentioStreamRaw[];
}

/**
 * Codec tokens. The separator between "H" and the number is `[.\s_-]?` rather
 * than `\.?` because Torrentio's title line has already had dots flattened to
 * spaces by the time we see it: real cached releases arrive as
 * "Dark S01E01 Secrets 2160p NF WEB-DL DUAL DDP5 1 Atmos H 265-Kitsune", and
 * "H 265" matched nothing. An unrecognised codec at 4K defaults to "safari"
 * (see `compat` below), so every miss here is a 4K row silently marked
 * unavailable — including the H 264 ones, which would have played.
 */
const HEVC_PATTERN = /x\s?265|hevc|h[.\s_-]?265/i;
const AV1_PATTERN = /\bav0?1\b/i;
const H264_PATTERN = /x\s?264|h[.\s_-]?264|avc1?/i;
const TRUEHD_AUDIO_PATTERN = /\btrue[ ._-]?hd\b/i;
const DTS_AUDIO_PATTERN = /\bdts(?:[ ._-]?(?:hd|x|ma))?\b/i;
const EAC3_AUDIO_PATTERN = /\be[ ._-]?ac[ ._-]?3\b|\bddp(?:\d|\b)|dolby[ ._-]?digital[ ._-]?plus/i;
const AC3_AUDIO_PATTERN = /\bac[ ._-]?3\b|\bdd(?:2|5|7)(?:[ ._-]?1)?\b|dolby[ ._-]?digital\b/i;
const FLAC_AUDIO_PATTERN = /\bflac\b/i;
const OPUS_AUDIO_PATTERN = /\bopus\b/i;
const AAC_AUDIO_PATTERN = /\baac(?:2|5|7)?(?:[ ._-]?1)?\b/i;
const MP3_AUDIO_PATTERN = /\bmp3\b/i;
const MULTI_AUDIO_PATTERN = /\bdual(?:[ ._-]?audio)?\b|\bmulti(?:[ ._-]?audio)?\b|\b2[ ._-]?audio\b/i;
const HDR_PATTERN = /\bhdr(?:10\+?)?\b|dolby\s?vision|\bdv\b/i;
const MKV_PATTERN = /\.mkv\b|\bmkv\b/i;
const MP4_PATTERN = /\.mp4\b|\bmp4\b/i;
const WEBM_PATTERN = /\.webm\b|\bwebm\b/i;
const MOV_PATTERN = /\.mov\b|\bmov\b/i;
/** REMUX releases are near-universally packaged as MKV even when the title never says ".mkv" literally — LIVE DATA confirms many 4K releases are exactly this shape. Only applied when no explicit container token was already found. */
const REMUX_PATTERN = /\bremux\b/i;
/**
 * `2160p` is a real resolution tag. A bare `4K` is a marketing word, and it
 * turns up in names that carry an explicit 1080p tag as well — a live roster
 * for Inception offers "Inception - Directors Cut 2010 Eng Ita Multi-Subs 4K
 * 1080p", which is a 1080p file. Reading that as 2160p is not a cosmetic
 * mislabel: it is the top-ranked member of the native-2160 class (MP4 beats
 * the MKV alternative on container), so it takes the one 4K roster slot a
 * Chrome session can actually use and leaves the genuine 4K AV1 release
 * sitting behind it unused.
 */
const RESOLUTION_2160_EXPLICIT_PATTERN = /2160p/i;
const RESOLUTION_4K_MARKETING_PATTERN = /\b4k\b/i;
const RESOLUTION_1080_PATTERN = /1080p/i;
const RESOLUTION_ANY_PATTERN = /(\d{3,4})p/i;
const SEEDERS_PATTERN = /👤[^\d]*(\d+)/;
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)\b/i;
/* The capture pattern moved to release-scorer.ts so the drop below and the
   ranking penalty there cannot drift apart. It is slightly broader now
   (hdtc, and separators inside telesync/telecine/camrip). */
const MOVIE_NON_FEATURE_PATTERN =
  /\b(?:featurettes?|bonus(?:es)?|extras?|soundtracks?|deleted[ ._-]?scenes?|imdb[ ._-]*top[ ._-]*\d+)\b/i;
const MOVIE_PACK_RELEASE_PATTERN =
  /\b(?:season[ ._-]?\d+|s\d{1,2}|complete[ ._-]?(?:series|season|pack)|collection|filmography|duology|trilogy)\b/i;

/** Season packs / collections / complete sets — not a single movie feature. */
export function isMoviePackRelease(text: string): boolean {
  return MOVIE_PACK_RELEASE_PATTERN.test(text);
}

/**
 * Pure title/filename classifier — no network. Exported for unit testing
 * against real sample release-name conventions.
 */
export function parseReleaseTitle(text: string): ParsedRelease {
  const t = text || "";

  let resolutionHeight: number | null;
  // Explicit 2160p wins outright; an explicit 1080p beats a bare "4K"; a bare
  // "4K" with no competing tag is still the best evidence available.
  if (RESOLUTION_2160_EXPLICIT_PATTERN.test(t)) resolutionHeight = 2160;
  else if (RESOLUTION_1080_PATTERN.test(t)) resolutionHeight = 1080;
  else if (RESOLUTION_4K_MARKETING_PATTERN.test(t)) resolutionHeight = 2160;
  else {
    const m = t.match(RESOLUTION_ANY_PATTERN);
    resolutionHeight = m ? Number(m[1]) : null;
  }

  const codec: ReleaseCodec = HEVC_PATTERN.test(t)
    ? "hevc"
    : AV1_PATTERN.test(t)
      ? "av1"
      : H264_PATTERN.test(t)
        ? "h264"
        : "unknown";

  // Order is significant: TrueHD/DTS/E-AC-3 names often also contain generic
  // Dolby/DD tokens. Preserve the most specific codec evidence available.
  const audioCodec: ReleaseAudioCodec = TRUEHD_AUDIO_PATTERN.test(t)
    ? "truehd"
    : DTS_AUDIO_PATTERN.test(t)
      ? "dts"
      : EAC3_AUDIO_PATTERN.test(t)
        ? "eac3"
        : AC3_AUDIO_PATTERN.test(t)
          ? "ac3"
          : FLAC_AUDIO_PATTERN.test(t)
            ? "flac"
            : OPUS_AUDIO_PATTERN.test(t)
              ? "opus"
              : AAC_AUDIO_PATTERN.test(t)
                ? "aac"
                : MP3_AUDIO_PATTERN.test(t)
                  ? "mp3"
                  : "unknown";
  const multiAudio = MULTI_AUDIO_PATTERN.test(t);

  const hdr = HDR_PATTERN.test(t);
  let container: ReleaseContainer;
  if (MKV_PATTERN.test(t)) container = "mkv";
  else if (MP4_PATTERN.test(t)) container = "mp4";
  else if (WEBM_PATTERN.test(t)) container = "webm";
  else if (MOV_PATTERN.test(t)) container = "mov";
  else if (REMUX_PATTERN.test(t)) container = "mkv";
  else container = "unknown";

  // HEVC/HDR/DV/MKV/WebM make this release a Chrome-decode risk — 4K HDR
  // remuxes are almost always HEVC-in-MKV and only decode in Safari. (MKV
  // itself isn't actually Safari-playable either — see the `compat` doc
  // comment above and `isBrowserPlayableContainer` below, which is the real
  // gate callers surfacing a source directly must use.)
  //
  // AV1 is the OPPOSITE case from HEVC: AV1-in-MP4/MOV is Chrome/Firefox-
  // native (software/hardware AV1 decode has been standard there for years)
  // and NOT reliably Safari-playable (Safari's AV1 support is recent/
  // partial, e.g. Apple Silicon Macs only, no iOS Safari support at all as
  // of this writing) — so it must NOT be folded into the same "safari"
  // bucket as HEVC. `codec: "av1"` is preserved either way so a Safari-
  // specific AV1 decode gate (browser/version capability check, not a
  // container/codec-class heuristic) can still be layered on top of this by
  // whatever ranks/gates sources for playback.
  // Compat is the browser-decode hint. HEVC/HDR/MKV/WebM → "safari" (only
  // Safari/HW-Chrome decode them). Additionally, at 4K (2160) with an UNKNOWN
  // codec, default to "safari" — the overwhelming majority of 4K releases are
  // HEVC/HDR (H.264 4K is essentially nonexistent), so treating an untagged 4K
  // release as "native" would mislead Chrome users into picking a source that
  // won't play. This matches the live data: 95%+ of 4K is HEVC. At 1080p,
  // unknown stays "native" (most 1080p is H.264, and the "unknown" tier was
  // explicitly kept eligible — see isBrowserPlayableContainer).
  //
  // Container is deliberately NOT part of this. It used to be: MKV and WebM
  // forced "safari", which put every H.264/AV1 MKV in the same bucket as an
  // x265 HDR remux and sank it behind `sortCandidates`/`selectTopPerClass`.
  // The result was visible on nearly every title - exactly ONE 4K row, the
  // HEVC one, because the decodable 4K releases were all MKV and therefore
  // classified as Safari-only. Since a stream copy now makes MKV playable
  // everywhere (see sourceDelivery/remux), the container decides HOW a source
  // is delivered, not WHO can watch it. Only the codec constrains that.
  const compat: ReleaseCompat =
    codec === "h264" || codec === "av1"
      ? "native"
      : codec === "hevc"
        ? "safari"
        : // Unknown codec — fall back to the release-shape heuristics, unchanged.
          hdr || resolutionHeight === 2160
          ? "safari"
          : "native";

  return {
    resolutionHeight,
    codec,
    audioCodec,
    multiAudio,
    hdr,
    container,
    compat,
  };
}

/**
 * Keep 720p in the candidate inventory as a last-resort native fallback.
 * Anything lower (or unresolved) remains out of scope.
 */
export function isEligibleDebridQuality(height: number | null): height is 720 | 1080 | 2160 {
  return height === 720 || height === 1080 || height === 2160;
}

/** Known-size floors so a 800 MB "1080p" cannot occupy a native HD slot. */
const MIN_DEBRID_SIZE_BYTES: Record<MediaType, Record<720 | 1080 | 2160, number>> = {
  movie: {
    720: Math.round(0.7 * 1024 ** 3),
    1080: 2 * 1024 ** 3,
    2160: 6 * 1024 ** 3,
  },
  tv: {
    720: Math.round(0.25 * 1024 ** 3),
    1080: Math.round(0.7 * 1024 ** 3),
    2160: Math.round(1.8 * 1024 ** 3),
  },
};

export function isLeanDebridSize(
  candidate: { resolutionHeight: 720 | 1080 | 2160; sizeBytes?: number },
  mediaType: MediaType
): boolean {
  if (candidate.sizeBytes == null || candidate.sizeBytes <= 0) return false;
  return candidate.sizeBytes < MIN_DEBRID_SIZE_BYTES[mediaType][candidate.resolutionHeight];
}

export function filterLeanDebridCandidates<T extends {
  resolutionHeight: 720 | 1080 | 2160;
  sizeBytes?: number;
}>(candidates: T[], mediaType: MediaType): T[] {
  if (candidates.length <= 1) return candidates;
  const kept = candidates.filter((candidate) => !isLeanDebridSize(candidate, mediaType));
  return kept.length ? kept : candidates;
}

/**
 * The real, absolute NATIVE browser-playability gate — MKV plays in NO
 * browser (not even Safari) and WebM movie releases are exotic/unsupported
 * enough to treat the same way. MP4/MOV are the only containers a `<video>`
 * tag can consume directly; "unknown" (no explicit container token in the
 * title) is kept eligible since the overwhelming majority of untagged
 * WEB-DL/HDTV encodes are MP4 in practice — never fabricated as literally
 * "mp4", just not excluded.
 *
 * NOTE: this is not used to drop inventory candidates here. The canonical
 * consumer is `isSourcePlayableHere` in source-quality.ts, which folds the
 * container and codec checks into one client-facing direct-play answer.
 */
export function isBrowserPlayableContainer(container: ReleaseContainer): boolean {
  return container !== "mkv" && container !== "webm";
}

/** File extension on the unrestricted CDN URL is ground truth. */
export function containerFromDirectUrl(url: string): ReleaseContainer | undefined {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    if (/\.mkv$/.test(pathname)) return "mkv";
    if (/\.webm$/.test(pathname)) return "webm";
    if (/\.mp4$/.test(pathname)) return "mp4";
    if (/\.mov$/.test(pathname)) return "mov";
  } catch {
    /* opaque URL stays unknown */
  }
  return undefined;
}

/**
 * Title heuristics (especially a bare "REMUX") lose to the actual file.
 * Switching Poseidon used to remux a playable MP4 because the torrent name
 * said REMUX/MKV.
 */
export function effectiveReleaseContainer(
  url: string,
  parsed?: ReleaseContainer
): ReleaseContainer | undefined {
  const fromUrl = containerFromDirectUrl(url);
  if (fromUrl) return fromUrl;
  if (parsed && parsed !== "unknown") return parsed;
  return parsed;
}

/**
 * Real-Debrid rows the player can attach as progressive files. MKV/WebM and
 * DTS/TrueHD/FLAC always take the remux worker, which is why switching to
 * Poseidon/Kronos felt like "packaging." Those files stay out of the RD
 * roster so every debrid chip starts immediately.
 */
export function isDirectPlayDebridRelease(
  container?: ReleaseContainer,
  audioCodec?: ReleaseAudioCodec
): boolean {
  if (container && !isBrowserPlayableContainer(container)) return false;
  if (audioCodec === "dts" || audioCodec === "truehd" || audioCodec === "flac") {
    return false;
  }
  return true;
}

/** Parsed from Torrentio's "👤 N" seeders footer (see sample titles in the test suite) — 0 when absent, never thrown on malformed text. */
export function parseSeeders(text: string): number {
  const m = (text || "").match(SEEDERS_PATTERN);
  return m ? Number(m[1]) : 0;
}

/** Parse Torrentio's selected-file size footer into bytes. */
export function parseSizeBytes(text: string): number | null {
  const match = (text || "").match(SIZE_PATTERN);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "gib" || unit === "gb"
      ? 1024 ** 3
      : 1024 ** 2;
  const bytes = value * multiplier;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

function compatRank(c: DebridCandidate): number {
  return c.compat === "native" ? 0 : 1;
}

/** Ranking bonus for a confidently natively-playable container over an "unknown" one — real signal used within a class; MKV/WebM simply score 0 here (no bonus, no exclusion — they still compete on resolution + seeders). */
const MP4_CONTAINER_BONUS = 50;
const MOV_CONTAINER_BONUS = 30;
/** Seeders reward, capped so one outlier torrent can't entirely dominate the in-class ranking. */
const SEEDERS_SCORE_CAP = 50;
const SEEDERS_WEIGHT = 2;

const SIZE_RICHNESS_MAX_SCORE = 400;
const SIZE_RICHNESS_HALF_SATURATION_BYTES: Record<
  MediaType,
  Record<720 | 1080 | 2160, number>
> = {
  movie: {
    720: Math.round(1.2 * 1024 ** 3),
    1080: 3 * 1024 ** 3,
    2160: 12 * 1024 ** 3,
  },
  tv: {
    720: Math.round(0.5 * 1024 ** 3),
    1080: Math.round(1.25 * 1024 ** 3),
    2160: 4 * 1024 ** 3,
  },
};

/**
 * Treat selected-file size as a bounded bitrate-richness proxy. Duration is
 * constant for candidates of one title/episode, so a larger file within the
 * same resolution/compatibility class is monotonically preferred. The
 * half-saturation point scales movies and episodes without making it a target:
 * scores keep increasing above it and approach, but never reach, the cap.
 * Missing size contributes nothing, preserving the neutral legacy behavior.
 */
function sizeRichnessScore(c: DebridCandidate, mediaType: MediaType): number {
  if (c.sizeBytes == null) return 0;
  const halfSaturation =
    SIZE_RICHNESS_HALF_SATURATION_BYTES[mediaType][c.resolutionHeight];
  return Math.round(
    SIZE_RICHNESS_MAX_SCORE *
      (c.sizeBytes / (c.sizeBytes + halfSaturation))
  );
}

/**
 * Composite size richness + bounded popularity + container confidence + how
 * the release was mastered.
 *
 * That last term is what stops a cam rip winning a class on seeders alone —
 * and a freshly-leaked cam has excellent seeders. See release-scorer.ts for
 * why it is bounded well below size richness rather than allowed to dominate.
 */
function candidateRankScore(c: DebridCandidate, mediaType: MediaType): number {
  const seederScore = Math.min(c.seeders, SEEDERS_SCORE_CAP) * SEEDERS_WEIGHT;
  const containerScore =
    c.container === "mp4" ? MP4_CONTAINER_BONUS : c.container === "mov" ? MOV_CONTAINER_BONUS : 0;
  return (
    c.resolutionHeight +
    sizeRichnessScore(c, mediaType) +
    seederScore +
    containerScore +
    releaseQualityScore(c)
  );
}

/** Native-compatible releases first, then resolution; in-class ties use bounded richness, health, container confidence, and mastering quality. */
function sortCandidates(
  list: DebridCandidate[],
  mediaType: MediaType
): DebridCandidate[] {
  return [...list].sort((a, b) => {
    const compatDiff = compatRank(a) - compatRank(b);
    if (compatDiff !== 0) return compatDiff;
    if (a.resolutionHeight !== b.resolutionHeight) return b.resolutionHeight - a.resolutionHeight;
    return candidateRankScore(b, mediaType) - candidateRankScore(a, mediaType);
  });
}

type CandidateClass =
  | "native-2160"
  | "safari-2160"
  | "native-1080"
  | "safari-1080"
  | "native-720"
  | "safari-720";

/**
 * Per-class caps for the returned candidate pool — sums to `MAX_CANDIDATES`.
 * "native-1080" gets the deepest cap ("several native 1080p" in the roster +
 * headroom for resolve-attempt fallbacks); native-2160 and safari-2160 get
 * enough depth for a fallback attempt or two without over-fetching a class
 * that's inherently scarce (native 4K) or already huge (safari 4K).
 */
const PER_CLASS_CAP: Record<CandidateClass, number> = {
  "native-2160": 5,
  "safari-2160": 5,
  "native-1080": 20,
  "safari-1080": 5,
  // One RD roster slot consumes this class only when no higher native slot
  // is available. Keep several candidates so validation can fall through.
  "native-720": 5,
  // A lower-quality source that still cannot direct-play has no value.
  "safari-720": 0,
};
/** Total candidate pool bound — see module header for why this replaced a flat top-8 cut. */
const MAX_CANDIDATES = Object.values(PER_CLASS_CAP).reduce((sum, n) => sum + n, 0);

function candidateClass(c: DebridCandidate): CandidateClass {
  return `${c.compat}-${c.resolutionHeight}` as CandidateClass;
}

/**
 * Ranks the full eligible (1080p+, MKV/WebM included — see module header)
 * pool by size richness, seeders, container, and mastering quality, then keeps
 * only the top N per class so the returned roster always has representation
 * across native/safari × 1080/2160 instead of being swamped by whichever class
 * Torrentio happens to return the most of (usually 4K HEVC/HDR remuxes, often
 * MKV).
 */
function selectTopPerClass(
  candidates: DebridCandidate[],
  mediaType: MediaType
): DebridCandidate[] {
  const buckets = new Map<CandidateClass, DebridCandidate[]>();
  for (const c of candidates) {
    const key = candidateClass(c);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const out: DebridCandidate[] = [];
  for (const key of Object.keys(PER_CLASS_CAP) as CandidateClass[]) {
    const cap = PER_CLASS_CAP[key];
    const ranked = (buckets.get(key) ?? []).sort((a, b) => {
      /**
       * Prefer the release that needs no server work.
       *
       * This began as a hard playability gate, back when an MKV slot was a
       * dead row: container was only a soft +50 in `candidateRankScore`, so a
       * better seeder count routinely handed the slot to something no browser
       * could open. Remux changed what it means — an MKV now plays, it just
       * costs a stream copy and a couple of seconds of startup first.
       *
       * So it stays ahead of the score, but as a cost preference rather than a
       * survival gate, and it matches `compareDelivery` on the client: at equal
       * class, direct beats remux. Same ordering, different reason.
       */
      const aPlayable = isBrowserPlayableContainer(a.container) ? 1 : 0;
      const bPlayable = isBrowserPlayableContainer(b.container) ? 1 : 0;
      if (aPlayable !== bPlayable) return bPlayable - aPlayable;
      return candidateRankScore(b, mediaType) - candidateRankScore(a, mediaType);
    });
    out.push(...ranked.slice(0, cap));
  }
  return sortCandidates(out, mediaType);
}

/** TMDB -> IMDb id. Torrentio (and Real-Debrid magnets generally) are keyed by imdb id. */
export async function resolveImdbId(tmdbId: number, mediaType: MediaType): Promise<string | null> {
  try {
    const result = await tmdb.externalIds(tmdbId, mediaType);
    return result?.imdb_id || null;
  } catch {
    return null;
  }
}

export interface FetchTorrentioParams {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  /** Real-Debrid token baked into the Torrentio config path segment (2a). */
  rdToken: string;
}

export interface FetchTorrentioNoDebridParams {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}

/** `stream/movie/<imdb>.json` or `stream/series/<imdb>:<s>:<e>.json` — the resource path, identical for the configured and un-configured endpoints. */
export function buildKindPath(params: {
  imdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}): string {
  const season = tvQueryIndex(params.season);
  const episode = tvQueryIndex(params.episode);
  return params.mediaType === "tv"
    ? `stream/series/${params.imdbId}:${season}:${episode}.json`
    : `stream/movie/${params.imdbId}.json`;
}

/** Shared fetch + JSON parse for either Torrentio endpoint. Never throws; returns null on any failure. */
async function fetchTorrentioJson(url: string): Promise<TorrentioResponseRaw | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TORRENTIO_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as TorrentioResponseRaw;
}

/**
 * Shared parse + filter (1080p+ only) + per-class rank/bound (see
 * `selectTopPerClass`) of a raw Torrentio response. Identical for both
 * endpoints. MKV/WebM candidates are KEPT (see module header) — their
 * `container`/`codec` are carried through unchanged so downstream (RD slot
 * selection, TorBox's own candidate reuse, and ultimately the client's
 * `isSourcePlayableHere`) can present them honestly without auto-selecting
 * an incompatible release.
 */
function parseTorrentioStreams(
  data: TorrentioResponseRaw,
  configuredDebrid: boolean,
  mediaType: MediaType
): DebridCandidate[] {
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const candidates: DebridCandidate[] = [];
  for (const s of streams) {
    // Configured responses contain instant `[RD+]` rows and non-cached
    // `[RD download]` rows. The latter still require a torrent transfer and
    // their resolve links can be placeholders, so they are never ready.
    if (configuredDebrid && /^\[RD download\]/i.test(s.name?.trim() ?? "")) {
      continue;
    }
    const text = `${s.title ?? ""} ${s.name ?? ""} ${s.behaviorHints?.filename ?? ""}`;
    if (isCaptureRelease(text)) continue;
    if (mediaType === "movie" && MOVIE_NON_FEATURE_PATTERN.test(text)) {
      continue;
    }
    if (mediaType === "movie" && isMoviePackRelease(text)) {
      continue;
    }
    const parsed = parseReleaseTitle(text);
    const height = parsed.resolutionHeight;
    const sizeBytes = parseSizeBytes(text);
    if (!isEligibleDebridQuality(height)) continue;

    const rawTitle = (s.title ?? s.name ?? "Unknown release").split("\n")[0]?.trim();
    candidates.push({
      ...parsed,
      resolutionHeight: height,
      title: rawTitle || "Unknown release",
      infoHash: s.infoHash ?? extractInfoHashFromResolveUrl(s.url),
      fileIdx: s.fileIdx,
      url: s.url,
      seeders: parseSeeders(text),
      ...(sizeBytes != null ? { sizeBytes } : {}),
    });
  }
  return selectTopPerClass(
    filterLeanDebridCandidates(candidates, mediaType),
    mediaType
  ).slice(0, MAX_CANDIDATES);
}

/**
 * Torrentio's RD-configured response sometimes omits `infoHash` even though
 * its resolve-proxy URL carries the same stable hash. Recover only the known
 * path shape; the credential segment is neither returned nor logged.
 */
export function extractInfoHashFromResolveUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/resolve\/realdebrid\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Fetch + parse + filter (1080p+ only; MKV/WebM kept, not dropped) + per-class rank/bound (~30-40 total, see `PER_CLASS_CAP`). Never throws. */
export async function fetchTorrentioCandidates(
  params: FetchTorrentioParams
): Promise<DebridCandidate[]> {
  try {
    const configSegment = `realdebrid=${encodeURIComponent(params.rdToken)}`;
    const kindPath = buildKindPath(params);
    const url = `${TORRENTIO_BASE}/${configSegment}/${kindPath}`;
    const data = await fetchTorrentioJson(url);
    if (!data) return [];
    return parseTorrentioStreams(data, true, params.mediaType);
  } catch {
    return [];
  }
}

/**
 * Un-configured Torrentio scrape (NO debrid token in the URL) — hits
 * `${TORRENTIO_BASE}/stream/...` directly. Returns the same raw
 * `DebridCandidate[]` (infoHash + parsed release), but each candidate's
 * `url` is a bare magnet/undefined rather than an RD resolve-proxy link, so
 * there is never any debrid token to leak. This is the candidate source for
 * the sibling TorBox tier when Real-Debrid is NOT configured — TorBox needs
 * only the provider-agnostic infoHashes, which it then feeds to its own
 * cache-check/add/requestdl flow on api.torbox.app. NO third-party token
 * (RD or TorBox) is ever placed in this request. Never throws.
 */
export async function fetchTorrentioCandidatesNoDebrid(
  params: FetchTorrentioNoDebridParams
): Promise<DebridCandidate[]> {
  try {
    const url = `${TORRENTIO_BASE}/${buildKindPath(params)}`;
    const data = await fetchTorrentioJson(url);
    if (!data) return [];
    return parseTorrentioStreams(data, false, params.mediaType);
  } catch {
    return [];
  }
}
