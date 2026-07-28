/**
 * LordFlix-style named servers + flags for UI.
 * Playback still uses our HLS sources; names/flags map onto PlaybackSource labels.
 */

export type ServerFlag = {
  name: string;
  flag: string;
};

/** Display order for known servers (default pick still uses probe ranking). */
export const SERVER_FLAGS: Record<string, ServerFlag> = {
  solstice: { name: "Solstice", flag: "🇺🇸" },
  aether: { name: "Aether", flag: "🇺🇸" },
  horizon: { name: "Horizon", flag: "🇺🇸" },
  vienna: { name: "Vienna", flag: "🇺🇸" },
  lion: { name: "Lion", flag: "🇺🇸" },
  phoenix: { name: "Phoenix", flag: "🇺🇸" },
  sakura: { name: "Sakura", flag: "🇯🇵" },
  luna: { name: "Luna", flag: "🇺🇸" },
  flower: { name: "Flower", flag: "🇫🇷" },
  rio: { name: "Rio", flag: "🇧🇷" },
  moscow: { name: "Moscow", flag: "🇷🇺" },
  pulse: { name: "Pulse", flag: "🇺🇸" },
  nova: { name: "Nova", flag: "🇺🇸" },
  orion: { name: "Orion", flag: "🇺🇸" },
  nest: { name: "Nest", flag: "🇺🇸" },
  flux: { name: "Flux", flag: "🇺🇸" },
  joy: { name: "Joy", flag: "🇺🇸" },
  astra: { name: "Astra", flag: "🇺🇸" },
  blaze: { name: "Blaze", flag: "🇺🇸" },
  quasar: { name: "Quasar", flag: "🇺🇸" },
  share: { name: "Share", flag: "🇺🇸" },
  berlin: { name: "Berlin", flag: "🇩🇪" },
  marseille: { name: "Marseille", flag: "🇫🇷" },
  oslo: { name: "Oslo", flag: "🇳🇴" },
  backrooms: { name: "Backrooms", flag: "🇺🇸" },
  ativa: { name: "Ativa", flag: "🇧🇷" },
  nebula: { name: "Nebula", flag: "🇺🇸" },
  zephyr: { name: "Zephyr", flag: "🇺🇸" },
  peach: { name: "Peach", flag: "🇺🇸" },
  tulip: { name: "Tulip", flag: "🇳🇱" },
  rock: { name: "Rock", flag: "🇺🇸" },
  pop: { name: "Pop", flag: "🇺🇸" },
  comet: { name: "Comet", flag: "🇺🇸" },
  "cinema-main": { name: "Cinema English", flag: "🇬🇧" },
  "cinema-en": { name: "Cinema English", flag: "🇬🇧" },
  "cinema-hi": { name: "Cinema Hindi", flag: "🇮🇳" },
  "cinema-ar": { name: "Cinema Arabic", flag: "🌐" },
  "cinema-fr": { name: "Cinema French", flag: "🇫🇷" },
  "cinema-es": { name: "Cinema Spanish", flag: "🇪🇸" },
  "cinema-de": { name: "Cinema German", flag: "🇩🇪" },
  "cinema-pt": { name: "Cinema Portuguese", flag: "🇵🇹" },
  "cinema-ja": { name: "Cinema Japanese", flag: "🇯🇵" },
  "cinema-ko": { name: "Cinema Korean", flag: "🇰🇷" },
  "cinema-zh": { name: "Cinema Chinese", flag: "🇨🇳" },
  "cinema-it": { name: "Cinema Italian", flag: "🇮🇹" },
  "cinema-ru": { name: "Cinema Russian", flag: "🇷🇺" },
  "cinema-tr": { name: "Cinema Turkish", flag: "🇹🇷" },
  "cinema-id": { name: "Cinema Indonesian", flag: "🇮🇩" },
  "cinema-th": { name: "Cinema Thai", flag: "🇹🇭" },
  "cinema-vi": { name: "Cinema Vietnamese", flag: "🇻🇳" },
  "cinema-nl": { name: "Cinema Dutch", flag: "🇳🇱" },
  "cinema-pl": { name: "Cinema Polish", flag: "🇵🇱" },
  "cinema-xx": { name: "Cinema Global", flag: "🌐" },
};

export function flagForServerName(name: string): string {
  const key = name.trim().toLowerCase().split(/\s+/)[0] || "";
  return SERVER_FLAGS[key]?.flag ?? "🌐";
}

export function huntingVerb(serverName: string): string {
  // LordFlix: "Hunting Solstice..."
  return `Hunting ${serverName}...`;
}
