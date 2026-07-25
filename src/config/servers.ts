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
};

export function flagForServerName(name: string): string {
  const key = name.trim().toLowerCase().split(/\s+/)[0] || "";
  return SERVER_FLAGS[key]?.flag ?? "🇺🇸";
}

export function huntingVerb(serverName: string): string {
  // LordFlix: "Hunting Solstice..."
  return `Hunting ${serverName}...`;
}
