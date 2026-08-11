import type {
  HealthRegistry,
  PlaybackSource,
  PlayerFeedback,
  ProviderHealthKey,
  ProviderHealthSnapshot,
} from "./types";

interface AttemptOutcome {
  attemptId: string;
  success: boolean;
  terminal: boolean;
  firstFrameSeen: boolean;
}

interface HealthBucket {
  outcomes: AttemptOutcome[];
  firstFrameMs: number[];
  terminalFailuresSinceCooldown: number;
  lastTerminalFailureAt?: number;
  cooldownUntil?: number;
}

interface OutcomeChange {
  firstFrameRecorded: boolean;
  terminalFailureRecorded: boolean;
}

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_MAX_SAMPLES = 64;
const DEFAULT_FAILURES_TO_COOLDOWN = 3;
const DEFAULT_COOLDOWN_MS = 90_000;
const DEFAULT_MAX_BUCKETS = 2_048;

const EMPTY_SNAPSHOT: ProviderHealthSnapshot = {
  successRate: 1,
  sampleCount: 0,
};

function compact(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function serialize(key: ProviderHealthKey): string {
  return JSON.stringify([
    key.viewerId ?? "*",
    key.provider.trim().toLowerCase(),
    key.contentClass ?? "*",
    key.domain?.trim().toLowerCase() ?? "*",
    key.route ?? "*",
    key.cdnFamily?.trim().toLowerCase() ?? "*",
  ]);
}

function feedbackAttemptId(feedback: PlayerFeedback): string {
  return (
    feedback.attemptId?.trim() ||
    `${feedback.event}:${feedback.sourceId}:${feedback.occurredAt}`
  );
}

function recordOutcome(
  bucket: HealthBucket,
  feedback: PlayerFeedback
): OutcomeChange {
  const attemptId = feedbackAttemptId(feedback);
  const existing = bucket.outcomes.find((item) => item.attemptId === attemptId);
  if (feedback.event === "first_frame") {
    if (existing?.firstFrameSeen) {
      return { firstFrameRecorded: false, terminalFailureRecorded: false };
    }
    if (existing) existing.firstFrameSeen = true;
    else {
      bucket.outcomes.push({
        attemptId,
        success: true,
        terminal: false,
        firstFrameSeen: true,
      });
    }
    return { firstFrameRecorded: true, terminalFailureRecorded: false };
  }
  if (existing?.terminal) {
    return { firstFrameRecorded: false, terminalFailureRecorded: false };
  }
  if (existing) {
    existing.success = false;
    existing.terminal = true;
  } else {
    bucket.outcomes.push({
      attemptId,
      success: false,
      terminal: true,
      firstFrameSeen: false,
    });
  }
  return { firstFrameRecorded: false, terminalFailureRecorded: true };
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
    { provider, viewerId: key.viewerId },
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
 * Process-local, viewer-scoped rollout registry. It implements the hierarchy
 * and attribution boundary now; shared persistence needs trusted aggregation
 * before it can safely replace this per-viewer scope. Stalls are excluded.
 */
export class HierarchicalHealthRegistry implements HealthRegistry {
  private readonly buckets = new Map<string, HealthBucket>();

  constructor(
    private readonly minSamples = DEFAULT_MIN_SAMPLES,
    private readonly maxSamples = DEFAULT_MAX_SAMPLES,
    private readonly failuresToCooldown = DEFAULT_FAILURES_TO_COOLDOWN,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
    private readonly maxBuckets = DEFAULT_MAX_BUCKETS
  ) {}

  lookup(key: ProviderHealthKey): ProviderHealthSnapshot {
    const hierarchy = healthKeyHierarchy(key);
    let fallback: HealthBucket | undefined;
    for (const candidate of hierarchy) {
      const bucket = this.buckets.get(serialize(candidate));
      if (!bucket) continue;
      fallback = bucket;
      if (bucket.outcomes.length >= this.minSamples) return this.snapshot(bucket);
    }
    return fallback ? this.snapshot(fallback) : EMPTY_SNAPSHOT;
  }

  observe(key: ProviderHealthKey, feedback: PlayerFeedback): void {
    const relevant =
      feedback.event === "first_frame" || feedback.event === "handoff_failed";
    // Stalls and recoverable decode errors are current-attempt signals. The
    // player emits handoff_failed only if recovery is exhausted.
    if (!relevant) return;
    for (const candidate of healthKeyHierarchy(key)) {
      const serialized = serialize(candidate);
      const bucket = this.buckets.get(serialized) ?? {
        outcomes: [],
        firstFrameMs: [],
        terminalFailuresSinceCooldown: 0,
      };
      const change = recordOutcome(bucket, feedback);
      if (change.terminalFailureRecorded) this.recordTerminalFailure(bucket);
      if (
        change.firstFrameRecorded &&
        feedback.timeToFirstFrameMs != null
      ) {
        bucket.firstFrameMs.push(feedback.timeToFirstFrameMs);
      }
      if (bucket.outcomes.length > this.maxSamples) bucket.outcomes.shift();
      if (bucket.firstFrameMs.length > this.maxSamples) {
        bucket.firstFrameMs.shift();
      }
      this.storeBucket(serialized, bucket);
    }
  }

  private snapshot(bucket: HealthBucket): ProviderHealthSnapshot {
    this.clearExpiredCooldown(bucket);
    const successes = bucket.outcomes.filter((item) => item.success).length;
    const cooldownUntil =
      bucket.cooldownUntil != null && bucket.cooldownUntil > Date.now()
        ? bucket.cooldownUntil
        : undefined;
    return {
      successRate:
        bucket.outcomes.length > 0 ? successes / bucket.outcomes.length : 1,
      sampleCount: bucket.outcomes.length,
      medianFirstSegmentMs: compact(bucket.firstFrameMs),
      cooldownUntil,
    };
  }

  private recordTerminalFailure(bucket: HealthBucket): void {
    this.clearExpiredCooldown(bucket);
    const now = Date.now();
    if (
      bucket.lastTerminalFailureAt != null &&
      now - bucket.lastTerminalFailureAt > this.cooldownMs
    ) {
      bucket.terminalFailuresSinceCooldown = 0;
    }
    bucket.lastTerminalFailureAt = now;
    bucket.terminalFailuresSinceCooldown += 1;
    if (bucket.terminalFailuresSinceCooldown >= this.failuresToCooldown) {
      bucket.cooldownUntil = now + this.cooldownMs;
    }
  }

  private clearExpiredCooldown(bucket: HealthBucket): void {
    if (bucket.cooldownUntil == null || bucket.cooldownUntil > Date.now()) return;
    bucket.cooldownUntil = undefined;
    bucket.terminalFailuresSinceCooldown = 0;
    bucket.lastTerminalFailureAt = undefined;
  }

  private storeBucket(key: string, bucket: HealthBucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (!oldest) return;
      this.buckets.delete(oldest);
    }
  }
}

export const providerHealthRegistry = new HierarchicalHealthRegistry();

/** Attach fresh process-local health without mutating a cached source roster. */
export function sourcesWithProviderHealth(
  sources: readonly PlaybackSource[],
  registry: HealthRegistry,
  context: Omit<ProviderHealthKey, "provider"> = {}
): PlaybackSource[] {
  return sources.map((source) => {
    const runtimeHealth = registry.lookup({
      ...context,
      provider: source.provider,
    });
    return runtimeHealth.sampleCount > 0
      ? { ...source, runtimeHealth }
      : source;
  });
}
