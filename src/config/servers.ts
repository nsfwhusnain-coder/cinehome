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
  solstice: { name: "Arriflex", flag: "🇺🇸" },
  aether: { name: "Cooke", flag: "🇺🇸" },
  horizon: { name: "Zeiss", flag: "🇺🇸" },
  vienna: { name: "Bolex", flag: "🇺🇸" },
  lion: { name: "Arri", flag: "🇺🇸" },
  phoenix: { name: "Eastman", flag: "🇺🇸" },
  sakura: { name: "Konica", flag: "🇯🇵" },
  luna: { name: "Scope", flag: "🇺🇸" },
  flower: { name: "Agfa", flag: "🇫🇷" },
  rio: { name: "Pathe", flag: "🇧🇷" },
  moscow: { name: "Mosfilm", flag: "🇷🇺" },
  pulse: { name: "Kineto", flag: "🇺🇸" },
  nova: { name: "Vista", flag: "🇺🇸" },
  orion: { name: "Todd", flag: "🇺🇸" },
  nest: { name: "Aaton", flag: "🇺🇸" },
  flux: { name: "Eclair", flag: "🇺🇸" },
  joy: { name: "Leica", flag: "🇺🇸" },
  astra: { name: "Super", flag: "🇺🇸" },
  blaze: { name: "CinemaScope", flag: "🇺🇸" },
  quasar: { name: "Prism", flag: "🇺🇸" },
  share: { name: "Fox", flag: "🇺🇸" },
  berlin: { name: "Ufa", flag: "🇩🇪" },
  marseille: { name: "Gaumont", flag: "🇫🇷" },
  oslo: { name: "Nordisk", flag: "🇳🇴" },
  backrooms: { name: "Studio", flag: "🇺🇸" },
  ativa: { name: "Vera", flag: "🇧🇷" },
  nebula: { name: "Orwo", flag: "🇺🇸" },
  zephyr: { name: "Angenieux", flag: "🇺🇸" },
  peach: { name: "Fuji", flag: "🇺🇸" },
  tulip: { name: "Ilford", flag: "🇳🇱" },
  rock: { name: "Mitchell", flag: "🇺🇸" },
  pop: { name: "Kodak", flag: "🇺🇸" },
  comet: { name: "Bell", flag: "🇺🇸" },
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
