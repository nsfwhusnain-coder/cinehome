import type { PlaybackSource } from "./types";
import {
  isSourcePlayableHere,
  pickDefaultSource,
  scoreSource,
} from "./source-quality";
import {
  baseServerToken,
  getServerDisplayName,
  resolutionBadge,
} from "./server-names";
import { SERVER_NAME_THEME } from "./server-theme";
import { flagForServerName } from "@/config/servers";

export interface ExpectedServer {
  id: string;
  /** Greek-themed display name — same theme table `getServerDisplayName`
   * uses, so this identity table can never drift from the live naming. */
  name: string;
  /** Matched against provider first, then label (lowercased). */
  providerHints: string[];
  /** Optional exact label matches (lowercased). Avoid bare labels that collide across providers. */
  labelHints?: string[];
}

export type ServerSlotStatus = "active" | "available" | "loading" | "failed" | "unavailable";

export interface ServerSlot {
  id: string;
  /** Greek-themed name ONLY — never includes quality/resolution (see `qualityLabel`). */
  name: string;
  status: ServerSlotStatus;
  source?: PlaybackSource;
  /** Small per-row resolution badge — identical text to the Cloud panel's
   * badge for the same source, since both come from `resolutionBadge`. */
  qualityLabel?: string;
  /** origin === "debrid" — Real-Debrid/TorBox premium tier, marked with a gold crown in the UI. */
  premium?: boolean;
  /** Curated provider/language flag, or a globe when geography is unknown. */
  flag?: string;
}

/**
 * Optional name hints for friendly labels. UI no longer shows empty roster slots —
 * only sources that exist (and preferably segment-verified) appear.
 *
 * `name` is derived from `SERVER_NAME_THEME`/`getServerDisplayName` (never a
 * hand-typed cosmic string) purely for identity/placeholder use elsewhere —
 * the actual live Server list rows (`buildServerSlots` below) compute their
 * name straight from each real source via `getServerDisplayName`, which is
 * the single source of truth; this table's `id`s are what `providerHints`/
 * `labelHints` match against and are unchanged from before.
 */
export const EXPECTED_SERVERS: ExpectedServer[] = [
  { id: "aether", name: SERVER_NAME_THEME.aether, providerHints: ["cinepro/icefy", "icefy"], labelHints: ["aether"] },
  { id: "horizon", name: SERVER_NAME_THEME.horizon, providerHints: ["cinepro/vidapi", "vidapi"], labelHints: ["horizon"] },
  { id: "solstice", name: SERVER_NAME_THEME.solstice, providerHints: ["vidking"], labelHints: ["solstice"] },
  { id: "pulse", name: SERVER_NAME_THEME.pulse, providerHints: ["notorrent"], labelHints: ["pulse"] },
  { id: "luna", name: SERVER_NAME_THEME.luna, providerHints: ["vixsrc", "cinepro/vixsrc"], labelHints: ["luna"] },
  { id: "phoenix", name: SERVER_NAME_THEME.phoenix, providerHints: ["vidlink"], labelHints: ["phoenix"] },
  // Generic CinePro catch-all (no specific sub-provider label) — themed via
  // the same fallback hash `getServerDisplayName` itself would use for this
  // exact (provider, label) pair, so it can never drift from live naming.
  { id: "cinepro", name: getServerDisplayName("cinepro", ""), providerHints: ["cinepro"], labelHints: [] },
  {
    id: "nova",
    name: SERVER_NAME_THEME.nova,
    providerHints: ["embed.su"],
    labelHints: ["nova"],
  },
  { id: "orion", name: SERVER_NAME_THEME.orion, providerHints: ["vidsrc"], labelHints: ["orion"] },
  { id: "nest", name: SERVER_NAME_THEME.nest, providerHints: ["vidnest"], labelHints: ["nest"] },
  { id: "joy", name: SERVER_NAME_THEME.joy, providerHints: ["vidjoy"], labelHints: ["joy"] },
  { id: "astra", name: SERVER_NAME_THEME.astra, providerHints: ["2embed"], labelHints: ["astra"] },
  { id: "blaze", name: SERVER_NAME_THEME.blaze, providerHints: ["multiembed"], labelHints: ["blaze"] },
  { id: "comet", name: SERVER_NAME_THEME.comet, providerHints: ["smashy"], labelHints: ["comet"] },
  // "videasy" hint stays live: CinePro's own OMSS sub-provider is named
  // "videasy" internally (see mini-services/stream-scraper/providers/cinepro.ts
  // friendlyLabel) and is surfaced as `CinePro/videasy` — this is NOT the
  // standalone Videasy API provider, which was removed 2026-07-21 (100%
  // zero-result over 24h of production logs).
  { id: "quasar", name: SERVER_NAME_THEME.quasar, providerHints: ["videasy"], labelHints: ["quasar"] },
  // "flux" (vidfast) and "nebula" (lordflix) removed 2026-07-21 — both source
  // providers are gone from the active roster (VidFast: persistent dead PW
  // embed; LordFlix: persistent zero-result API provider). See
  // docs/research/fmhy-15plus-source-map.md.
];

function haystack(source: PlaybackSource): string {
  return `${source.provider} ${source.label} ${source.id}`.toLowerCase();
}

/**
 * Provider-first matching so Lordflix "Luna"/"Phoenix" server labels do not
 * steal Vixsrc/VidLink slots.
 */
export function matchSourceToServer(source: PlaybackSource): string {
  const provider = source.provider.trim().toLowerCase();
  const label = source.label.trim().toLowerCase();

  for (const server of EXPECTED_SERVERS) {
    if (server.providerHints.some((hint) => provider.includes(hint.toLowerCase()))) {
      return server.id;
    }
  }

  for (const server of EXPECTED_SERVERS) {
    const labels = server.labelHints ?? [];
    if (labels.some((hint) => label === hint.toLowerCase() || label.startsWith(hint.toLowerCase()))) {
      return server.id;
    }
  }

  const text = haystack(source);
  for (const server of EXPECTED_SERVERS) {
    if (server.providerHints.some((hint) => text.includes(hint.toLowerCase()))) {
      return server.id;
    }
  }

  return "unknown";
}

/**
 * The SAME `getServerDisplayName` call the Cloud-panel quick switch uses
 * (see `player-controls.tsx`) — passing `provider`, `label`, AND `id` so a
 * given source shows the exact same Greek name here in the settings-dock
 * Server section as it does there. Quality is intentionally never part of
 * this name (see `resolutionBadge` for the separate badge).
 */
function displayName(source: PlaybackSource): string {
  return getServerDisplayName(source.provider, source.label, source.id);
}

/**
 * Server-list filter for LordFlix-style multi-server switching.
 * Keep probe-ok + unprobed always. Keep probe-failed when allowUnprobed
 * (manual test) or sticky; auto-default still prefers ok via pickDefault.
 */
export function filterPlayableSources(
  sources: PlaybackSource[],
  opts?: { allowUnprobed?: boolean; stickyId?: string }
): PlaybackSource[] {
  if (!sources.length) return [];
  const allowUnprobed = opts?.allowUnprobed ?? false;
  const stickyId = opts?.stickyId;

  return sources.filter((s) => {
    if (stickyId && s.id === stickyId) return true;
    if (s.probe?.ok === true) return true;
    if (s.probe == null) return true;
    // probe.ok === false: still list when allowUnprobed so user can re-test.
    if (s.probe?.ok === false) return allowUnprobed;
    return true;
  });
}

function slotStatus(
  source: PlaybackSource,
  failedSet: Set<string>,
  activeSourceId?: string
): ServerSlotStatus {
  if (failedSet.has(source.id)) return "failed";
  if (source.id === activeSourceId) return "active";
  return "available";
}

/**
 * Server list = only real, preferably segment-verified sources.
 * No empty placeholders (Pulse/Nova loading forever).
 */
export function buildServerSlots(
  sources: PlaybackSource[],
  failedIds: string[],
  isDiscovering: boolean,
  activeSourceId?: string
): ServerSlot[] {
  const failedSet = new Set(failedIds);
  // Always allow unprobed in the picker so background enrich can surface new servers.
  const playable = filterPlayableSources(sources, {
    allowUnprobed: true,
    stickyId: activeSourceId,
  }).filter(
    (source) =>
      !failedSet.has(source.id) &&
      source.probe?.ok !== false &&
      source.verified !== false &&
      isSourcePlayableHere(source)
  );

  // Session-failed and conclusively dead rows are removed above. Keep the
  // surviving roster ranked by measured source score without placeholders.
  const ranked = [...playable].sort((a, b) => {
    return scoreSource(b) - scoreSource(a);
  });
  // A provider can publish the same logical server as separate fixed-quality
  // URLs (CinemaOS commonly returns RU 1080 + RU 720). Quality belongs in
  // the quality rail, not as duplicate server rows. Since ranking happens
  // first, keep the best healthy representation for each stable server name.
  const seenNames = new Set<string>();
  const uniqueServers = ranked.filter((source) => {
    const name = displayName(source);
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });

  return uniqueServers.map((source) => ({
    id: source.id,
    name: displayName(source),
    status: slotStatus(source, failedSet, activeSourceId),
    source,
    qualityLabel: resolutionBadge(source),
    premium: source.origin === "debrid",
    flag: flagForServerName(baseServerToken(source.provider, source.label)),
  }));
}

/** Best playable source for auto-start / recovery. */
export function pickPlayableDefault(
  sources: PlaybackSource[],
  preferred?: string | null,
  failedIds: string[] = []
): PlaybackSource | null {
  const failed = new Set(failedIds);
  const playable = filterPlayableSources(sources, { allowUnprobed: true }).filter(
    (s) => !failed.has(s.id)
  );
  if (!playable.length) return null;
  return pickDefaultSource(playable, preferred);
}
