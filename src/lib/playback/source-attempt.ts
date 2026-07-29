/**
 * Source-attempt identity and failure policy.
 *
 * Media engines are asynchronous. A destroyed hls.js/dash.js instance can
 * still deliver a late callback after React has selected another source. The
 * generation token makes those callbacks harmless: only the currently bound
 * source attempt may accrue failures or claim a terminal transition.
 *
 * The policy keeps identity/arbitration engine-independent while making
 * recovery capability explicit:
 * - two hard transport failures without playback progress => fail over;
 * - one silent-stall recovery nudge is allowed when the active engine has a
 *   real recovery primitive (hls.js/dash.js);
 * - a native progressive source, which has no recovery engine, fails over on
 *   its first complete no-progress window;
 * - a second full no-progress window => fail over;
 * - real playhead progress clears transient strikes.
 */

export interface SourceAttemptToken {
  readonly sourceId: string;
  readonly generation: number;
}

export type AttemptFailureSignal = "ignored" | "retry" | "recover" | "terminal";
export type AttemptRefreshSignal =
  | "ignored"
  | "started"
  | "pending"
  | "exhausted";

interface AttemptState {
  token: SourceAttemptToken;
  hardTransportFailures: number;
  stallRecoveries: number;
  refreshing: boolean;
  terminalClaimed: boolean;
}

export class SourceAttemptController {
  private generation = 0;
  private current: AttemptState | null = null;
  /**
   * A refreshed roster can preserve the same stable source ID while changing
   * only its signed URL. Keep this budget outside AttemptState so an unchanged,
   * still-expired source cannot start a fresh refresh loop on every generation.
   */
  private readonly refreshAttemptsBySource = new Map<string, number>();

  constructor(
    private readonly hardTransportFailureLimit = 2,
    private readonly stallRecoveryLimit = 1,
    private readonly sessionRefreshLimit = 1
  ) {
    if (hardTransportFailureLimit < 1) {
      throw new Error("hardTransportFailureLimit must be at least 1");
    }
    if (stallRecoveryLimit < 0) {
      throw new Error("stallRecoveryLimit cannot be negative");
    }
    if (sessionRefreshLimit < 1) {
      throw new Error("sessionRefreshLimit must be at least 1");
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
      refreshing: false,
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

  /**
   * Only measured playhead advancement is healthy enough to reopen signed-URL
   * refresh recovery. A `playing` event alone can precede another immediate
   * 410 and must not make the cross-generation budget unbounded.
   */
  noteHealthyPlayback(token: SourceAttemptToken): void {
    if (!this.isCurrent(token)) return;
    this.noteProgress(token);
    this.refreshAttemptsBySource.delete(token.sourceId);
  }

  /**
   * Clear title-scoped history when the media identity changes. Source IDs are
   * stable within a roster, but may be reused by a provider for another title.
   */
  resetRefreshBudget(): void {
    this.refreshAttemptsBySource.clear();
  }

  noteHardTransportFailure(token: SourceAttemptToken): AttemptFailureSignal {
    if (!this.isCurrent(token) || !this.current) return "ignored";
    // A signed-URL refresh owns this generation until it either produces a
    // replacement attempt or explicitly times out. Duplicate transport events
    // from the stopped engine must not race the refresh into source failover.
    if (this.current.refreshing) return "ignored";
    this.current.hardTransportFailures += 1;
    return this.current.hardTransportFailures >= this.hardTransportFailureLimit
      ? "terminal"
      : "retry";
  }

  noteSilentStall(
    token: SourceAttemptToken,
    recoveryAvailable = true
  ): AttemptFailureSignal {
    if (!this.isCurrent(token) || !this.current) return "ignored";
    if (this.current.refreshing) return "ignored";
    if (!recoveryAvailable) return "terminal";
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
    if (this.current.refreshing) return false;
    this.current.terminalClaimed = true;
    return true;
  }

  /**
   * Claim one in-flight signed-URL refresh for this exact source generation.
   * Repeated HLS 410 callbacks are absorbed as `pending`; stale callbacks from
   * a destroyed engine are ignored.
   */
  requestRefresh(token: SourceAttemptToken): AttemptRefreshSignal {
    if (!this.isCurrent(token) || !this.current) return "ignored";
    if (this.current.refreshing) return "pending";
    const attempts = this.refreshAttemptsBySource.get(token.sourceId) ?? 0;
    if (attempts >= this.sessionRefreshLimit) return "exhausted";
    this.refreshAttemptsBySource.set(token.sourceId, attempts + 1);
    this.current.refreshing = true;
    return "started";
  }

  /**
   * End refresh ownership after an explicit rejection/timeout. A successful
   * refresh normally supersedes this generation via begin()/invalidate().
   */
  finishRefresh(token: SourceAttemptToken): boolean {
    if (!this.current || !this.matches(token, this.current.token)) return false;
    if (!this.current.refreshing || this.current.terminalClaimed) return false;
    this.current.refreshing = false;
    return true;
  }

  private matches(a: SourceAttemptToken, b: SourceAttemptToken): boolean {
    return a.generation === b.generation && a.sourceId === b.sourceId;
  }
}
