export interface ProviderArm<T> {
  provider: string;
  run: () => Promise<T[]>;
}

export interface ProviderRaceOutcome {
  provider: string;
  ms: number;
  count: number;
  status: "hit" | "empty" | "error";
  late: boolean;
  error?: string;
}

export interface ProviderRaceResult<T> {
  entries: T[];
  outcomes: ProviderRaceOutcome[];
  firstHitMs: number | null;
  totalMs: number;
}

/**
 * Start every provider independently and return after the first useful result
 * plus a short quality grace. A slow/dead arm can never gate the response; it
 * may still enrich the cache when it eventually settles.
 */
export async function raceProviderArms<T>(
  arms: ProviderArm<T>[],
  options: {
    firstHitGraceMs: number;
    maxWaitMs: number;
    onLateEntries?: (provider: string, entries: T[]) => void;
    onOutcome?: (outcome: ProviderRaceOutcome) => void;
  }
): Promise<ProviderRaceResult<T>> {
  const started = Date.now();
  const entries: T[] = [];
  const outcomes: ProviderRaceOutcome[] = [];
  let firstHitAt: number | null = null;
  let remaining = arms.length;
  let returned = false;

  if (arms.length === 0) {
    return { entries, outcomes, firstHitMs: null, totalMs: 0 };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const maxTimer = setTimeout(finish, options.maxWaitMs);

    function finish(): void {
      if (settled) return;
      settled = true;
      returned = true;
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(maxTimer);
      resolve();
    }

    function publish(outcome: ProviderRaceOutcome): void {
      outcomes.push(outcome);
      options.onOutcome?.(outcome);
    }

    for (const arm of arms) {
      const armStarted = Date.now();
      Promise.resolve()
        .then(() => arm.run())
        .then((result) => {
          const late = returned;
          publish({
            provider: arm.provider,
            ms: Date.now() - armStarted,
            count: result.length,
            status: result.length ? "hit" : "empty",
            late,
          });
          if (!result.length) return;
          if (late) {
            options.onLateEntries?.(arm.provider, result);
            return;
          }
          entries.push(...result);
          if (firstHitAt == null) {
            firstHitAt = Date.now();
            graceTimer = setTimeout(finish, options.firstHitGraceMs);
          }
        })
        .catch((error: unknown) => {
          publish({
            provider: arm.provider,
            ms: Date.now() - armStarted,
            count: 0,
            status: "error",
            late: returned,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          remaining -= 1;
          if (remaining <= 0) finish();
        });
    }
  });

  return {
    entries: [...entries],
    outcomes: [...outcomes],
    firstHitMs: firstHitAt == null ? null : firstHitAt - started,
    totalMs: Date.now() - started,
  };
}
