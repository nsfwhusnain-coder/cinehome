import { describe, expect, it } from "bun:test";
import type { SourceAttemptToken } from "./source-attempt";
import { RosterRecoveryArbiter } from "./roster-recovery";

function token(sourceId: string, generation: number): SourceAttemptToken {
  return { sourceId, generation };
}

describe("RosterRecoveryArbiter", () => {
  it("defers automatic rescue while a signed-session request settles", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);

    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.completeSessionRequest(owner)).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("ignores buffered progress from the generation that initiated renewal", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);
    expect(arbiter.completeSessionRequest(owner)).toBe("held");

    expect(arbiter.isInitiatingGeneration(owner)).toBe(true);
    expect(arbiter.noteHealthy(owner)).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("drops a deferred rescue after the replacement generation advances", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    const replacement = token("vixsrc-luna", 6);
    arbiter.beginSession(owner);
    arbiter.observeAttempt(replacement);
    expect(arbiter.requestAutomatic()).toBe("defer");

    expect(arbiter.completeSessionRequest(owner)).toBe("held");
    expect(arbiter.isInitiatingGeneration(replacement)).toBe(false);
    expect(arbiter.noteHealthy(replacement)).toBe("released");
    expect(arbiter.requestAutomatic()).toBe("start");
  });

  it("allows rescue after a settled replacement becomes terminal", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    const replacement = token("vixsrc-luna", 6);
    arbiter.beginSession(owner);
    arbiter.observeAttempt(replacement);
    expect(arbiter.completeSessionRequest(owner)).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");

    expect(arbiter.noteTerminal(replacement)).toBe("released");
    expect(arbiter.requestAutomatic()).toBe("start");
    expect(arbiter.requestAutomatic()).toBe("exhausted");
  });

  it("hands off a deferred rescue only after a terminal request unwinds", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);

    expect(arbiter.noteTerminal(owner)).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.completeSessionRequest(owner)).toBe("start-deferred");
    expect(arbiter.requestAutomatic()).toBe("exhausted");
  });

  it("hands off an empty-roster rescue after the request promise settles", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);

    expect(arbiter.noteNoReplacement()).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.completeSessionRequest(owner)).toBe("start-deferred");
  });

  it("drops session ownership when recovery switches to a peer", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);
    expect(
      arbiter.observeAttempt(token("vidking-solstice", 5))
    ).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");

    expect(arbiter.completeSessionRequest(owner)).toBe("released");
    expect(arbiter.requestAutomatic()).toBe("start");
  });

  it("hands off rescue when an in-flight peer fails before request settlement", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    const peer = token("vidking-solstice", 5);
    arbiter.beginSession(owner);
    expect(arbiter.observeAttempt(peer)).toBe("held");

    expect(arbiter.noteTerminal(peer)).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.completeSessionRequest(owner)).toBe("start-deferred");
    expect(arbiter.requestAutomatic()).toBe("exhausted");
  });

  it("does not let a stale generation end the current session owner", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);

    expect(arbiter.noteTerminal(token("vixsrc-luna", 2))).toBe("held");
    expect(arbiter.noteHealthy(token("vixsrc-luna", 2))).toBe("held");
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("retains the in-flight owner across a synchronous peer failover", () => {
    const arbiter = new RosterRecoveryArbiter();
    const owner = token("vixsrc-luna", 4);
    arbiter.beginSession(owner);
    expect(arbiter.requestAutomatic()).toBe("defer");

    expect(arbiter.sessionOwnerSourceId()).toBe("vixsrc-luna");
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("resets both layers on title identity change", () => {
    const arbiter = new RosterRecoveryArbiter();
    expect(arbiter.requestAutomatic()).toBe("start");
    arbiter.beginSession(token("vixsrc-luna", 4));

    arbiter.reset();
    expect(arbiter.requestAutomatic()).toBe("start");
  });
});
