export interface EnrichmentRegistration {
  readonly leader: boolean;
  targets(): readonly string[];
  markTimedOut(): void;
  finish(): readonly string[] | null;
}

interface EnrichmentState {
  readonly targets: Set<string>;
  timedOut: boolean;
  finished: boolean;
}

export function coalescedEnrichmentKey(resultKey: string): string {
  const separator = resultKey.lastIndexOf(":");
  const pass = separator >= 0 ? resultKey.slice(separator + 1) : "";
  return pass === "fast" || pass === "full"
    ? resultKey.slice(0, separator)
    : resultKey;
}

export class EnrichmentCoalescer {
  private readonly active = new Map<string, EnrichmentState>();

  get activeCount(): number {
    return this.active.size;
  }

  hasJob(jobKey: string): boolean {
    return this.active.has(jobKey);
  }

  hasTarget(targetKey: string): boolean {
    for (const state of this.active.values()) {
      if (!state.timedOut && state.targets.has(targetKey)) return true;
    }
    return false;
  }

  join(jobKey: string, targetKey: string): EnrichmentRegistration {
    const existing = this.active.get(jobKey);
    if (existing) {
      existing.targets.add(targetKey);
      return this.registration(jobKey, existing, false);
    }

    const state: EnrichmentState = {
      targets: new Set([targetKey]),
      timedOut: false,
      finished: false,
    };
    this.active.set(jobKey, state);
    return this.registration(jobKey, state, true);
  }

  private registration(
    jobKey: string,
    state: EnrichmentState,
    leader: boolean
  ): EnrichmentRegistration {
    return {
      leader,
      targets: () => [...state.targets],
      markTimedOut: () => {
        state.timedOut = true;
      },
      finish: () => {
        if (state.finished) return null;
        state.finished = true;
        if (this.active.get(jobKey) === state) this.active.delete(jobKey);
        return [...state.targets];
      },
    };
  }
}
