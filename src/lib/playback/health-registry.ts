import type {
  HealthRegistry,
  PlayerFeedback,
  ProviderHealthKey,
  ProviderHealthSnapshot,
} from "./types";

interface HealthBucket {
  samples: boolean[];
  firstFrameMs: number[];
}

const EMPTY_SNAPSHOT: ProviderHealthSnapshot = {
  successRate: 1,
  sampleCount: 0,
};

function compact(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function serialize(key: ProviderHealthKey): string {
  return [
    key.provider.trim().toLowerCase(),
    key.contentClass ?? "*",
    key.domain?.trim().toLowerCase() ?? "*",
    key.route ?? "*",
    key.cdnFamily?.trim().toLowerCase() ?? "*",
  ].join("|");
}

/** Most-specific first, dropping CDN → route → domain → content class. */
export function healthKeyHierarchy(
  key: ProviderHealthKey
): ProviderHealthKey[] {
  const provider = key.provider.trim().toLowerCase();
  const candidates: ProviderHealthKey[] = [
    { ...key, provider },
    { ...key, provider, cdnFamily: undefined },
    { ...key, provider, cdnFamily: undefined, route: undefined },
    {
      ...key,
      provider,
      cdnFamily: undefined,
      route: undefined,
      domain: undefined,
    },
    { provider },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const serialized = serialize(candidate);
    if (seen.has(serialized)) return false;
    seen.add(serialized);
    return true;
  });
}

/**
 * Process-local rollout registry. It implements the hierarchy and attribution
 * boundary now; SQLite persistence can be added without changing callers.
 * Stalls are intentionally excluded from global provider health.
 */
export class HierarchicalHealthRegistry implements HealthRegistry {
  private readonly buckets = new Map<string, HealthBucket>();

  constructor(
    private readonly minSamples = 5,
    private readonly maxSamples = 64
  ) {}

  lookup(key: ProviderHealthKey): ProviderHealthSnapshot {
    const hierarchy = healthKeyHierarchy(key);
    let fallback: HealthBucket | undefined;
    for (const candidate of hierarchy) {
      const bucket = this.buckets.get(serialize(candidate));
      if (!bucket) continue;
      fallback = bucket;
      if (bucket.samples.length >= this.minSamples) return this.snapshot(bucket);
    }
    return fallback ? this.snapshot(fallback) : EMPTY_SNAPSHOT;
  }

  observe(key: ProviderHealthKey, feedback: PlayerFeedback): void {
    const success =
      feedback.event === "first_frame" ||
      feedback.event === "decoded_resolution"
        ? true
        : feedback.event === "decode_error" ||
            feedback.event === "handoff_failed"
          ? false
          : null;
    // Rebuffer is current-playback signal only and never poisons global health.
    if (success == null) return;
    for (const candidate of healthKeyHierarchy(key)) {
      const serialized = serialize(candidate);
      const bucket = this.buckets.get(serialized) ?? {
        samples: [],
        firstFrameMs: [],
      };
      bucket.samples.push(success);
      if (
        feedback.event === "first_frame" &&
        feedback.timeToFirstFrameMs != null
      ) {
        bucket.firstFrameMs.push(feedback.timeToFirstFrameMs);
      }
      if (bucket.samples.length > this.maxSamples) bucket.samples.shift();
      if (bucket.firstFrameMs.length > this.maxSamples) {
        bucket.firstFrameMs.shift();
      }
      this.buckets.set(serialized, bucket);
    }
  }

  private snapshot(bucket: HealthBucket): ProviderHealthSnapshot {
    const successes = bucket.samples.filter(Boolean).length;
    return {
      successRate:
        bucket.samples.length > 0 ? successes / bucket.samples.length : 1,
      sampleCount: bucket.samples.length,
      medianFirstSegmentMs: compact(bucket.firstFrameMs),
    };
  }
}

export const providerHealthRegistry = new HierarchicalHealthRegistry();
