/**
 * Film-exhibition naming theme for the Server list (see `server-names.ts`).
 *
 * Two DISJOINT pools so a blended Server list (premium rows sit inline with
 * free ones) can never show the same name for two genuinely different
 * logical servers.
 *
 * Every mapping here is a static table or a pure string→string function.
 * Nothing in this file reads render order, array index, or randomness —
 * that is what keeps a source's name identical across re-renders,
 * background-probe updates, and reopening the panel.
 */

/**
 * Shared stable-list cap for BOTH server-list UIs (the Cloud-icon quick
 * switch panel and the settings-dock "Server" section) — one constant so
 * they can never drift apart on how many rows show before "Show N more".
 */
export const STABLE_SERVER_CAP = 12;

/**
 * Free-CDN / embed roster pool. Camera houses, stocks, and exhibition
 * formats — Absolute Cinema, not another cosmic/Greek mashup.
 */
export const FILM_POOL = [
  "Arriflex",
  "Cooke",
  "Zeiss",
  "Bolex",
  "Arri",
  "Eastman",
  "Konica",
  "Scope",
  "Agfa",
  "Pathe",
  "Mosfilm",
  "Kineto",
  "Vista",
  "Todd",
  "Aaton",
  "Eclair",
  "Leica",
  "Super",
  "CinemaScope",
  "Prism",
  "Fox",
  "Ufa",
  "Gaumont",
  "Nordisk",
  "Studio",
  "Vera",
  "Orwo",
  "Angenieux",
  "Fuji",
  "Ilford",
  "Mitchell",
  "Kodak",
  "Bell",
  "Gate",
] as const;

/** @deprecated Use FILM_POOL. Kept so older tests/imports keep compiling. */
export const GREEK_POOL = FILM_POOL;

/**
 * Reserved exclusively for the Real-Debrid/TorBox premium tier — never
 * reused for a free-CDN provider (see module docstring).
 */
export const PREMIUM_NAMES = {
  /** RD native-compat (browser-safe H.264) 4K slot — the rare, best pick. */
  rdNative4k: "IMAX",
  /** RD remux 4K (HEVC/MKV) — the cached Ultra library. */
  rdSafari4k: "Seventy",
  /** RD's native-compat 1080p slots share this base; instances get numerals. */
  rdNative1080: "Panavision",
  /** RD remux 1080p (MKV / lossless audio) — packaged on pick. */
  rdRemux1080: "Cinerama",
  /** TorBox 4K row. */
  torbox4k: "Dolby",
  /** TorBox 1080p row. */
  torbox1080: "Atmos",
  /** Any debrid source that doesn't match a known bucket. */
  fallback: "Academy",
} as const;

export const PREMIUM_FILM_POOL: readonly string[] = Object.values(PREMIUM_NAMES);
/** @deprecated Use PREMIUM_FILM_POOL. */
export const PREMIUM_GREEK_POOL = PREMIUM_FILM_POOL;

/**
 * Canonical raw token → exhibition name. Tokens stay the same (luna,
 * quasar, phoenix…) so source identity, flags, and memory keys never move.
 */
export const SERVER_NAME_THEME: Readonly<Record<string, string>> = {
  solstice: "Arriflex",
  aether: "Cooke",
  horizon: "Zeiss",
  vienna: "Bolex",
  lion: "Arri",
  phoenix: "Eastman",
  sakura: "Konica",
  luna: "Scope",
  flower: "Agfa",
  rio: "Pathe",
  moscow: "Mosfilm",
  pulse: "Kineto",
  nova: "Vista",
  orion: "Todd",
  nest: "Aaton",
  flux: "Eclair",
  joy: "Leica",
  astra: "Super",
  blaze: "CinemaScope",
  quasar: "Prism",
  share: "Fox",
  berlin: "Ufa",
  marseille: "Gaumont",
  oslo: "Nordisk",
  backrooms: "Studio",
  ativa: "Vera",
  nebula: "Orwo",
  zephyr: "Angenieux",
  peach: "Fuji",
  tulip: "Ilford",
  rock: "Mitchell",
  pop: "Kodak",
  comet: "Bell",
  embed: "Gate",
};

/** "" for instance 1 (no suffix); "II"/"III"/... beyond that. */
export function toRomanSuffix(instance: number): string {
  const ROMAN = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  if (instance <= 1) return "";
  const idx = instance - 2;
  return idx < ROMAN.length ? ` ${ROMAN[idx]}` : ` ${instance}`;
}

/**
 * Deterministic fallback for a token with no curated `SERVER_NAME_THEME`
 * row — a stable string hash into `FILM_POOL`.
 */
export function hashTokenToThemeName(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return FILM_POOL[hash % FILM_POOL.length]!;
}

/** @deprecated Use hashTokenToThemeName. */
export const hashTokenToGreekName = hashTokenToThemeName;
