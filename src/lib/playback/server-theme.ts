/**
 * Greek-gods naming theme for the Server list (see `server-names.ts`, which
 * owns the actual dispatch logic and is the only place these tables are
 * consumed). Pulled into its own file so the free-CDN embed roster and the
 * Real-Debrid/TorBox premium tier can draw from two DISJOINT name pools —
 * a blended Server list (premium rows sit inline with free ones, never a
 * separate section) can then never show the same Greek name for two
 * genuinely different logical servers.
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
export const STABLE_SERVER_CAP = 10;

/**
 * Free-CDN / embed roster pool. One entry per raw "cosmic" token this app
 * has ever surfaced (scraper provider buckets in server-names.ts, plus the
 * CinePro/LordFlix passthrough labels in config/servers.ts) — see
 * `SERVER_NAME_THEME` below for the token→name assignment. Extend this pool
 * (and add a row to `SERVER_NAME_THEME`) if a brand-new provider needs one.
 */
export const GREEK_POOL = [
  "Zeus", "Apollo", "Atlas", "Helios", "Ares", "Hermes", "Nyx", "Eos", "Hera",
  "Iris", "Nike", "Selene", "Athena", "Artemis", "Dionysus", "Persephone",
  "Hephaestus", "Triton", "Rhea", "Pan", "Hecate", "Morpheus", "Boreas", "Notus",
  "Chaos", "Uranus", "Theia", "Hypnos", "Eros", "Thanatos", "Nemesis", "Tyche",
  "Circe", "Orpheus",
] as const;

/**
 * Reserved exclusively for the Real-Debrid/TorBox premium tier — never
 * reused for a free-CDN provider (see module docstring).
 */
export const PREMIUM_NAMES = {
  /** RD native-compat (browser-safe H.264) 4K slot — the rare, best pick. */
  rdNative4k: "Poseidon",
  /** RD Safari-only (HEVC/HDR) 4K slot. */
  rdSafari4k: "Hades",
  /** RD's three native-compat 1080p slots share this base name; the three
   * instances are disambiguated with a Roman numeral (see server-names.ts
   * `debridGreekName`) sourced from that slot's own id suffix — never from
   * sibling order. */
  rdNative1080: "Kronos",
  /** TorBox 4K row (either compat — TorBox only ever ships one row per
   * quality tier per title, so no numeral collision is possible). */
  torbox4k: "Demeter",
  /** TorBox 1080p row. */
  torbox1080: "Hestia",
  /** Any debrid source that doesn't match a known bucket (future-proofing —
   * still Greek-themed, never a raw fallback string). */
  fallback: "Gaia",
} as const;

export const PREMIUM_GREEK_POOL: readonly string[] = Object.values(PREMIUM_NAMES);

/**
 * Canonical raw token → Greek name. The token is whatever
 * `resolveEmbedToken` in server-names.ts extracts from either the raw
 * scraper `provider` string (vidlink/vidking/vixsrc/...) or the first word
 * of an already-friendly passthrough `label` (Aether/Horizon/Vienna/...,
 * CinePro + LordFlix-style multi-CDN captures). One row per token that has
 * ever reached this app's Server list — see config/servers.ts SERVER_FLAGS
 * and source-quality.ts/source-identity.ts for the full historical roster.
 */
export const SERVER_NAME_THEME: Readonly<Record<string, string>> = {
  solstice: "Zeus",
  aether: "Apollo",
  horizon: "Atlas",
  vienna: "Helios",
  lion: "Ares",
  phoenix: "Hermes",
  sakura: "Nyx",
  luna: "Eos",
  flower: "Hera",
  rio: "Iris",
  moscow: "Nike",
  pulse: "Selene",
  nova: "Athena",
  orion: "Artemis",
  nest: "Dionysus",
  flux: "Persephone",
  joy: "Hephaestus",
  astra: "Triton",
  blaze: "Rhea",
  quasar: "Pan",
  share: "Hecate",
  berlin: "Morpheus",
  marseille: "Boreas",
  oslo: "Notus",
  backrooms: "Chaos",
  ativa: "Uranus",
  nebula: "Theia",
  zephyr: "Hypnos",
  peach: "Eros",
  tulip: "Thanatos",
  rock: "Nemesis",
  pop: "Tyche",
  comet: "Circe",
  embed: "Orpheus",
};

/** "" for instance 1 (no suffix); "II"/"III"/... beyond that. Deterministic,
 * pure function of the instance number — never of sibling order or index. */
export function toRomanSuffix(instance: number): string {
  const ROMAN = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  if (instance <= 1) return "";
  const idx = instance - 2;
  return idx < ROMAN.length ? ` ${ROMAN[idx]}` : ` ${instance}`;
}

/**
 * Deterministic fallback for a token with no curated `SERVER_NAME_THEME`
 * row (a brand-new provider we haven't themed yet) — a stable string hash
 * into `GREEK_POOL` so the name is still always Greek, always the same for
 * that token, and never randomly assigned.
 */
export function hashTokenToGreekName(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return GREEK_POOL[hash % GREEK_POOL.length]!;
}
