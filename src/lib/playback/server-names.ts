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
  hashTokenToThemeName,
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
  if (lowerProvider.includes("vidrock")) return "rock";
  if (lowerProvider.includes("videasy")) return "quasar";
  if (lowerProvider.includes("embed")) return "embed";
  return lowerProvider;
}

/** "Phoenix 2" → { token: "phoenix", instance: 2 }; "Share 1080p" → token
 * "share"; "Cinema AR 1080" → token "cinema-ar". Resolution words never
 * become identity, but meaningful words after the first one do. The previous
 * first-word-only parser collapsed every CinemaOS locale/CDN row to "Eos",
 * making the UI unable to identify or deterministically select a source. */
function parseLabelToken(label: string): { token: string; instance: number } {
  const parts = label.trim().split(/\s+/);
  const trailing = parts.at(-1) ?? "";
  const trailingNumber = /^\d+$/.test(trailing) ? Number(trailing) : null;
  // Capture indices are small ("Phoenix 2"). Bare video heights are common
  // in provider labels ("Cinema AR 1080") and are quality, not identity.
  const hasTrailingInstance =
    trailingNumber != null && trailingNumber > 0 && trailingNumber < 100;
  const instance = hasTrailingInstance ? Number(trailing) : 1;
  const withoutInstance = hasTrailingInstance ? parts.slice(0, -1) : parts;
  const semantic = withoutInstance.filter(
    (part) => !/^(?:auto|4k|\d{3,4}p|\d{3,4})$/i.test(part)
  );
  const token = semantic.join("-").toLowerCase() || (parts[0] ?? "").toLowerCase();
  return { token, instance };
}

function resolveEmbedToken(provider: string, label?: string): { token: string; instance: number } {
  const rawLabel = (label ?? "").trim();
  if (rawLabel && !isGenericLabel(rawLabel)) {
    const parsed = parseLabelToken(rawLabel);
    // CinemaOS occasionally returns a generic "Cinema" label without a
    // locale/CDN suffix. Keep it disjoint from Vixsrc's curated "Luna" → Eos.
    if (
      parsed.token === "cinema" &&
      provider.trim().toLowerCase().includes("cinemaos")
    ) {
      return { token: "cinema-main", instance: parsed.instance };
    }
    return parsed;
  }
  return { token: providerToken(provider.trim().toLowerCase()), instance: 1 };
}

function greekNameForToken(token: string, instance: number): string {
  const base = SERVER_NAME_THEME[token] ?? hashTokenToThemeName(token || "stream");
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

  if (is4k) {
    if (isSafari) {
      const remuxInstance = id?.match(/safari-2160-([2-9])$/)?.[1];
      return `${PREMIUM_NAMES.rdSafari4k}${toRomanSuffix(remuxInstance ? Number(remuxInstance) : 1)}`;
    }
    const nativeInstance = id?.match(/native-2160-([2-9])$/)?.[1];
    return `${PREMIUM_NAMES.rdNative4k}${toRomanSuffix(nativeInstance ? Number(nativeInstance) : 1)}`;
  }

  if (id?.includes("safari-1080")) {
    return PREMIUM_NAMES.rdRemux1080;
  }

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
