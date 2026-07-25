/**
 * Source-attempt identity and failure policy.
 *
 * Media engines are asynchronous. A destroyed hls.js/dash.js instance can
 * still deliver a late callback after React has selected another source. The
 * generation token makes those callbacks harmless: only the currently bound
 * source attempt may accrue failures or claim a terminal transition.
 *
 * The policy is deliberately engine-independent:
 * - two hard transport failures without playback progress => fail over;
 * - one silent-stall recovery nudge is allowed;
 * - a second full no-progress window => fail over;
 * - real playhead progress clears transient strikes.
 */

export interface SourceAttemptToken {
  readonly sourceId: string;
  readonly generation: number;
}

export type AttemptFailureSignal = "ignored" | "retry" | "recover" | "terminal";

interface AttemptState {
  token: SourceAttemptToken;
  hardTransportFailures: number;
  stallRecoveries: number;
  terminalClaimed: boolean;
}

export class SourceAttemptController {
  private generation = 0;
  private current: AttemptState | null = null;

  constructor(
    private readonly hardTransportFailureLimit = 2,
    private readonly stallRecoveryLimit = 1
  ) {
    if (hardTransportFailureLimit < 1) {
      throw new Error("hardTransportFailureLimit must be at least 1");
    }
    if (stallRecoveryLimit < 0) {
      throw new Error("stallRecoveryLimit cannot be negative");
    }
  }

  begin(sourceId: string): SourceAttemptToken {
    const token = Object.freeze({
      sourceId,
      generation: ++this.generation,
    });
    this.current = {
      token,
      hardTransportFailures: 0,
      stallRecoveries: 0,
      terminalClaimed: false,
    };
    return token;
  }

  currentToken(): SourceAttemptToken | null {
    return this.current?.token ?? null;
  }

  isCurrent(token: SourceAttemptToken | null | undefined): boolean {
    return Boolean(
      token &&
        this.current &&
        !this.current.terminalClaimed &&
        token.generation === this.current.token.generation &&
        token.sourceId === this.current.token.sourceId
    );
  }

  /**
   * Invalidate before tearing down an engine or scheduling a source change.
   * Any load/error callbacks emitted by the old engine after this point are
   * ignored even if React has not committed the next render yet.
   */
  invalidate(token?: SourceAttemptToken | null): void {
    if (!this.current) return;
    if (token && !this.matches(token, this.current.token)) return;
    this.current = null;
  }

  noteProgress(token: SourceAttemptToken): void {
    if (!this.isCurrent(token) || !this.current) return;
    this.current.hardTransportFailures = 0;
    this.current.stallRecoveries = 0;
  }

  noteHardTransportFailure(token: SourceAttemptToken): AttemptFailureSignal {
    if (!this.isCurrent(token) || !this.current) return "ignored";
    this.current.hardTransportFailures += 1;
    return this.current.hardTransportFailures >= this.hardTransportFailureLimit
      ? "terminal"
      : "retry";
  }

  noteSilentStall(token: SourceAttemptToken): AttemptFailureSignal {
    if (!this.isCurrent(token) || !this.current) return "ignored";
    if (this.current.stallRecoveries < this.stallRecoveryLimit) {
      this.current.stallRecoveries += 1;
      return "recover";
    }
    return "terminal";
  }

  /**
   * Exactly one terminal callback may own a generation. This prevents a hard
   * HTTP storm, media error, and watchdog tick from advancing through several
   * sources at once.
   */
  claimTerminal(token: SourceAttemptToken): boolean {
    if (!this.isCurrent(token) || !this.current) return false;
    this.current.terminalClaimed = true;
    return true;
  }

  private matches(a: SourceAttemptToken, b: SourceAttemptToken): boolean {
    return a.generation === b.generation && a.sourceId === b.sourceId;
  }
}
