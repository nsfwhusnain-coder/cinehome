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
  // Generic provider labels do not prove geography. Only explicit
  // CinemaOS language/locale tokens get flags; everything else gets a globe.
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
