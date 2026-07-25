/**
 * Hard-timeout race for background enrich.
 * Clears the timer when work settles first so late ticks never fire onHardTimeout.
 */

export type RaceOutcome = "work" | "timeout";

/**
 * Race `work` against a hard timeout of `ms`.
 *
 * - If work settles first: timer is cleared; `onHardTimeout` never runs.
 * - If timeout wins first: `onHardTimeout` runs once; late work may still complete
 *   in the background (caller owns side effects).
 * - Work rejection settles as "work" for timeout purposes (no hard-timeout log),
 *   then rethrows so the caller can `.catch` as usual.
 */
export function raceWithHardTimeout(
  work: Promise<unknown>,
  ms: number,
  onHardTimeout: () => void
): Promise<RaceOutcome> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<RaceOutcome>((resolve) => {
    timer = setTimeout(() => {
      if (settled) {
        resolve("timeout");
        return;
      }
      settled = true;
      onHardTimeout();
      resolve("timeout");
    }, ms);
  });

  const workPromise: Promise<RaceOutcome> = work.then(
    () => {
      settled = true;
      return "work";
    },
    (err: unknown) => {
      settled = true;
      throw err;
    }
  );

  return Promise.race([workPromise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
