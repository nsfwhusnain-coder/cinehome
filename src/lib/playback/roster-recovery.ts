import type { SourceAttemptToken } from "./source-attempt";

export type AutomaticRosterRefreshDecision =
  | "start"
  | "defer"
  | "exhausted";

export type RosterRecoveryTransition =
  | "held"
  | "released"
  | "start-deferred";

type SessionOutcome =
  | "open"
  | "healthy"
  | "terminal"
  | "no-replacement"
  | "peer";

interface SessionRecovery {
  owner: SourceAttemptToken;
  replacement: SourceAttemptToken | null;
  requestSettled: boolean;
  deferredAutomatic: boolean;
  outcome: SessionOutcome;
}

/**
 * Title-scoped arbitration between two different recovery layers:
 *
 * 1. a signed-session refresh owns its initiating generation until the
 *    transport settles and a replacement generation advances or terminates;
 * 2. the broader automatic roster rescue may run once, but never while layer
 *    one is still in flight or adopting its result.
 *
 * Source ID alone is insufficient: the stopped engine may continue decoding
 * buffered frames while its replacement roster is in flight. Those old frames
 * must not release ownership or consume the one broader rescue.
 */
export class RosterRecoveryArbiter {
  private session: SessionRecovery | null = null;
  private automaticUsed = false;

  beginSession(owner: SourceAttemptToken): void {
    this.session = {
      owner,
      replacement: null,
      requestSettled: false,
      deferredAutomatic: false,
      outcome: "open",
    };
  }

  /**
   * Progress from the stopped initiating engine may be buffered, so it cannot
   * reopen the source controller's cross-generation refresh budget.
   */
  isInitiatingGeneration(attempt: SourceAttemptToken): boolean {
    return Boolean(
      this.session && this.matches(attempt, this.session.owner)
    );
  }

  sessionOwnerSourceId(): string | null {
    return this.session?.owner.sourceId ?? null;
  }

  /**
   * Record the engine generation created from the recovered roster. A peer
   * source completes the signed-source layer without spending the title rescue.
   */
  observeAttempt(attempt: SourceAttemptToken): RosterRecoveryTransition {
    const session = this.session;
    if (!session || this.matches(attempt, session.owner)) return "held";
    session.replacement = attempt;
    if (attempt.sourceId !== session.owner.sourceId) {
      session.outcome = "peer";
      return this.releaseBenignOutcome();
    }
    return "held";
  }

  /**
   * Only measured progress from the replacement generation proves renewal.
   * Buffered progress from the initiating generation is deliberately ignored.
   */
  noteHealthy(attempt: SourceAttemptToken): RosterRecoveryTransition {
    const session = this.session;
    if (
      !session?.replacement ||
      !this.matches(attempt, session.replacement)
    ) {
      return "held";
    }
    session.outcome = "healthy";
    return this.releaseBenignOutcome();
  }

  /**
   * A generation-bound terminal claim releases adoption ownership. When the
   * recovery request is still unwinding, retain the state so a deferred title
   * rescue cannot accidentally share and consume that same transport promise.
   */
  noteTerminal(attempt: SourceAttemptToken): RosterRecoveryTransition {
    const session = this.session;
    if (!session || !this.belongsToSession(attempt, session)) return "held";
    session.outcome = "terminal";
    if (!session.requestSettled) return "held";
    this.session = null;
    return "released";
  }

  /**
   * The authoritative recovery roster contained no adoptable generation.
   * This is a real settled outcome, not a reason to retain an ownerless lock.
   */
  noteNoReplacement(): RosterRecoveryTransition {
    const session = this.session;
    if (!session) return "held";
    session.outcome = "no-replacement";
    if (!session.requestSettled) return "held";
    this.session = null;
    return "released";
  }

  /**
   * Called from the signed-session request's finally path. Only this edge may
   * hand off an already-deferred rescue automatically: terminal/no-roster was
   * established while the transport was still live, so the player has already
   * re-evaluated its current peer roster and explicitly asked to rescue.
   */
  completeSessionRequest(
    owner: SourceAttemptToken
  ): RosterRecoveryTransition {
    const session = this.session;
    if (!session || !this.matches(owner, session.owner)) return "held";
    session.requestSettled = true;
    if (session.outcome === "healthy" || session.outcome === "peer") {
      this.session = null;
      return "released";
    }
    if (
      session.outcome === "terminal" ||
      session.outcome === "no-replacement"
    ) {
      const startDeferred = session.deferredAutomatic;
      this.session = null;
      if (startDeferred && !this.automaticUsed) {
        this.automaticUsed = true;
        return "start-deferred";
      }
      return "released";
    }
    return "held";
  }

  requestAutomatic(): AutomaticRosterRefreshDecision {
    if (this.session) {
      this.session.deferredAutomatic = true;
      return "defer";
    }
    if (this.automaticUsed) return "exhausted";
    this.automaticUsed = true;
    return "start";
  }

  reset(): void {
    this.session = null;
    this.automaticUsed = false;
  }

  private releaseBenignOutcome(): RosterRecoveryTransition {
    if (!this.session?.requestSettled) return "held";
    this.session = null;
    return "released";
  }

  private belongsToSession(
    attempt: SourceAttemptToken,
    session: SessionRecovery
  ): boolean {
    return (
      this.matches(attempt, session.owner) ||
      Boolean(
        session.replacement &&
          this.matches(attempt, session.replacement)
      )
    );
  }

  private matches(a: SourceAttemptToken, b: SourceAttemptToken): boolean {
    return a.generation === b.generation && a.sourceId === b.sourceId;
  }
}
