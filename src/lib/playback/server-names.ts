/**
 * Maps scraper provider/label identity to a stable, Greek-gods-themed
 * server name (see `server-theme.ts` for the name pools/tables).
 *
 * DETERMINISM CONTRACT: `getServerDisplayName` is a pure function of
 * (provider, label, id) — never of array index, sibling sources, or
 * anything random — so a source's name can never change across
 * re-renders, background-probe updates, or the user switching servers.
 * Quality/resolution is intentionally NEVER part of the returned name
 * (callers show that separately — see qualityBadge in source-quality.ts);
 * only genuine same-name-same-slot collisions (RD's three native 1080p
 * slots; numbered multi-CDN captures like "Phoenix 2") get a Roman-numeral
 * suffix, extracted from that source's OWN id/label — never from
 * comparing against other sources in the current list.
 */
import {
  PREMIUM_NAMES,
  SERVER_NAME_THEME,
  hashTokenToGreekName,
  toRomanSuffix,
} from "./server-theme";
import type { PlaybackSource } from "./types";
import { qualityBadge } from "./source-quality";

const GENERIC_LABELS = new Set(["hls", "dash", "mp4", "direct", "stream", "auto", "link"]);

function isGenericLabel(label: string): boolean {
  return GENERIC_LABELS.has(label.trim().toLowerCase());
}

function isDebridProvider(lowerProvider: string): boolean {
  return lowerProvider === "debrid" || lowerProvider === "torbox" || lowerProvider === "premium";
}

function isDebridLabel(rawLabel: string): boolean {
  return /\bdebrid\b|\btorbox\b/i.test(rawLabel);
}

/** Raw scraper `provider` string → canonical embed token (same bucketing as
 * the pre-theme mapping — only the OUTPUT name changed below). */
function providerToken(lowerProvider: string): string {
  if (lowerProvider.includes("vidlink")) return "phoenix";
  if (lowerProvider.includes("vidking")) return "solstice";
  if (lowerProvider.includes("vixsrc")) return "luna";
  if (lowerProvider.includes("notorrent")) return "pulse";
  if (lowerProvider.includes("embed.su")) return "nova";
  if (lowerProvider.includes("vidsrc")) return "orion";
  if (lowerProvider.includes("vidnest")) return "nest";
  if (lowerProvider.includes("vidjoy")) return "joy";
  if (lowerProvider.includes("2embed")) return "astra";
  if (lowerProvider.includes("multiembed")) return "blaze";
  if (lowerProvider.includes("smashy")) return "comet";
  // "videasy" stays: CinePro's own OMSS sub-provider is internally named
  // "videasy" (provider string `CinePro/videasy`) — not the removed
  // standalone Videasy API provider. "vidfast" (Flux) and "lordflix"
  // (Nebula) were removed 2026-07-21 — both dropped from the active roster,
  // kept themed below only so a stray cached label never falls out of theme.
  if (lowerProvider.includes("videasy")) return "quasar";
  if (lowerProvider.includes("embed")) return "embed";
  return lowerProvider;
}

/** "Phoenix 2" → { token: "phoenix", instance: 2 }; "Share 1080p" / "Vienna"
 * → instance 1 (a bare trailing INTEGER word is a multi-CDN capture index,
 * never a quality token, which always carries a trailing "p"/"K"). */
function parseLabelToken(label: string): { token: string; instance: number } {
  const parts = label.trim().split(/\s+/);
  const token = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).join(" ");
  const instance = /^\d+$/.test(rest) ? Number(rest) : 1;
  return { token, instance };
}

function resolveEmbedToken(provider: string, label?: string): { token: string; instance: number } {
  const rawLabel = (label ?? "").trim();
  if (rawLabel && !isGenericLabel(rawLabel)) return parseLabelToken(rawLabel);
  return { token: providerToken(provider.trim().toLowerCase()), instance: 1 };
}

function greekNameForToken(token: string, instance: number): string {
  const base = SERVER_NAME_THEME[token] ?? hashTokenToGreekName(token || "stream");
  return `${base}${toRomanSuffix(instance)}`;
}

/**
 * Real-Debrid/TorBox premium tier naming — draws from the disjoint
 * `PREMIUM_NAMES` pool (see server-theme.ts) so it can never collide with a
 * free-CDN embed name in the same blended list.
 *
 * RD's three native-1080p slots (`native-1080-1/2/3` — see
 * src/lib/playback/debrid/index.ts `RD_SLOTS`) are the one place a real
 * same-name collision exists (identical provider AND label): the Roman
 * numeral there comes from that slot's OWN id suffix
 * (`...-native-1080-<n>`), never from comparing against sibling sources —
 * so it is stable even if the roster's other slots haven't resolved yet.
 */
function debridGreekName(lowerProvider: string, lowerLabel: string, id?: string): string {
  const isTorbox = lowerProvider === "torbox" || lowerLabel.includes("torbox");
  const is4k = /4k|2160/.test(lowerLabel);
  const is1080 = /1080/.test(lowerLabel);
  const isSafari = /safari/.test(lowerLabel);

  if (isTorbox) {
    if (is4k) return PREMIUM_NAMES.torbox4k;
    if (is1080) return PREMIUM_NAMES.torbox1080;
    return PREMIUM_NAMES.fallback;
  }

  if (is4k) return isSafari ? PREMIUM_NAMES.rdSafari4k : PREMIUM_NAMES.rdNative4k;

  if (is1080) {
    const slotMatch = id?.match(/-1080-([1-9])$/);
    const instance = slotMatch ? Number(slotMatch[1]) : 1;
    return `${PREMIUM_NAMES.rdNative1080}${toRomanSuffix(instance)}`;
  }

  return PREMIUM_NAMES.fallback;
}

/**
 * Base (pre-theme) identity token for a source — "phoenix", "aether",
 * "vienna", etc. for embed sources, or "" for a debrid/premium source
 * (which has no meaningful CDN-geography flag). Exists purely so callers
 * that still want the existing per-server flag emoji (`flagForServerName`
 * in config/servers.ts, keyed by these same pre-theme tokens) can look it
 * up WITHOUT the flag table itself ever needing to learn Greek names.
 */
export function baseServerToken(provider: string, label?: string): string {
  const lowerProvider = provider.trim().toLowerCase();
  const rawLabel = (label ?? "").trim();
  if (isDebridProvider(lowerProvider) || isDebridLabel(rawLabel)) return "";
  return resolveEmbedToken(provider, label).token;
}

/**
 * The server's stable, Greek-themed display name — see the module
 * docstring for the determinism contract. `id` is optional (existing call
 * sites that only have provider/label keep working unchanged) but should be
 * passed whenever available: it's the only thing that can disambiguate RD's
 * three identically-labeled native-1080p slots.
 */
export function getServerDisplayName(provider: string, label?: string, id?: string): string {
  const lowerProvider = provider.trim().toLowerCase();
  const rawLabel = (label ?? "").trim();

  if (isDebridProvider(lowerProvider) || isDebridLabel(rawLabel)) {
    return debridGreekName(lowerProvider, rawLabel.toLowerCase(), id);
  }

  const { token, instance } = resolveEmbedToken(provider, label);
  return greekNameForToken(token, instance);
}

/**
 * Per-row resolution badge (4K/1080p/… + honest "· transcode" tag when the
 * source needs the in-container transcoder rather than native decode) —
 * quality lives HERE, never in the server name above. Strips
 * `qualityBadge`'s own "(Debrid)"/"(TorBox)" suffix since every caller that
 * uses this also renders a dedicated premium crown marker (ServersPanel,
 * PlayerDock's Server section) — showing both would be redundant. Single
 * shared implementation so the Cloud panel and the settings-dock Server
 * section can never disagree on a source's badge text.
 */
export function resolutionBadge(source: PlaybackSource): string {
  const badge = qualityBadge(source);
  return source.origin === "debrid" ? badge.replace(/\s*\((?:Debrid|TorBox)\)$/, "") : badge;
}

export function sourceId(provider: string, label: string): string {
  const l = label.trim().toLowerCase();
  const server = l && !GENERIC_LABELS.has(l) ? label.trim() : "";
  const slug = `${provider}-${server || provider}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return slug.slice(0, 64);
}
