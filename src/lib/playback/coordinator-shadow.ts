import type {
  FourKStartupPreference,
  PlaybackQualityPreference,
} from "@/lib/profile-preferences";
import { pickClientStartupSource } from "./client-ranking";
import { isPoisonStreamUrl } from "./poison-url";
import { isSourcePlayableHere } from "./source-quality";
import type {
  CandidateReadiness,
  IdentityEvidence,
  PlaybackSource,
} from "./types";

export interface ShadowCandidateSummary {
  sourceId: string;
  provider: string;
  origin: "embed" | "debrid";
  readiness: CandidateReadiness;
  identityEvidence: IdentityEvidence;
  eligible: boolean;
}

export interface CoordinatorShadowDecision {
  mode: "shadow";
  candidateCount: number;
  eligibleReadyCount: number;
  immediateSourceId: string | null;
  deferredFourKSourceId: string | null;
  reason: "ranked_best" | "fast_start_direct_hd" | "no_source";
  candidates: ShadowCandidateSummary[];
}

/**
 * Observation-only projection of the existing roster into the new lifecycle.
 * It never mutates selection and deliberately excludes URLs/tokens from logs.
 */
export function buildCoordinatorShadowDecision(
  sources: readonly PlaybackSource[],
  preferences: {
    playbackQuality: PlaybackQualityPreference;
    fourKStartup: FourKStartupPreference;
  }
): CoordinatorShadowDecision {
  const candidates = sources.map((source): ShadowCandidateSummary => {
    const playable = isSourcePlayableHere(source);
    const eligible =
      playable &&
      !isPoisonStreamUrl(source.url) &&
      source.verified !== false;
    const readiness: CandidateReadiness =
      eligible && source.probe?.ok !== false
        ? "transport_verified"
        : source.url
          ? "resolved"
          : "discovered";
    return {
      sourceId: source.id,
      provider: source.provider,
      origin: source.origin === "debrid" ? "debrid" : "embed",
      readiness,
      identityEvidence:
        source.origin === "debrid" ? "release_title" : "exact_media_route",
      eligible,
    };
  });
  const rankableIds = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.eligible && candidate.readiness === "transport_verified"
      )
      .map((candidate) => candidate.sourceId)
  );
  const decision = pickClientStartupSource(
    sources.filter((source) => rankableIds.has(source.id)),
    {
      preferredHeight: preferences.playbackQuality,
      fourKStartup: preferences.fourKStartup,
    }
  );
  return {
    mode: "shadow",
    candidateCount: candidates.length,
    eligibleReadyCount: rankableIds.size,
    immediateSourceId: decision.immediate?.id ?? null,
    deferredFourKSourceId: decision.deferredFourK?.id ?? null,
    reason: decision.reason,
    candidates,
  };
}
