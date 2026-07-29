export type AutomaticRosterRefreshDecision =
  | "start"
  | "defer"
  | "exhausted";

/**
 * Title-scoped arbitration between two different recovery layers:
 *
 * 1. a signed-session refresh owns its logical source until that renewed
 *    generation either advances or becomes terminal;
 * 2. the broader automatic roster rescue may run once, but never while layer
 *    one is still settling.
 *
 * Keeping these states together prevents discovery-close effects from
 * launching a duplicate cache-bypass request in the short render window
 * between a recovery response and refreshed-engine adoption.
 */
export class RosterRecoveryArbiter {
  private sessionSourceId: string | null = null;
  private automaticUsed = false;

  beginSession(sourceId: string): void {
    this.sessionSourceId = sourceId;
  }

  endSession(sourceId: string): boolean {
    if (this.sessionSourceId !== sourceId) return false;
    this.sessionSourceId = null;
    return true;
  }

  cancelSessionUnless(sourceId: string): void {
    if (this.sessionSourceId && this.sessionSourceId !== sourceId) {
      this.sessionSourceId = null;
    }
  }

  requestAutomatic(): AutomaticRosterRefreshDecision {
    if (this.sessionSourceId) return "defer";
    if (this.automaticUsed) return "exhausted";
    this.automaticUsed = true;
    return "start";
  }

  reset(): void {
    this.sessionSourceId = null;
    this.automaticUsed = false;
  }
}

