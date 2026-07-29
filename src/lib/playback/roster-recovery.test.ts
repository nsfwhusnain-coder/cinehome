import { describe, expect, it } from "bun:test";
import { RosterRecoveryArbiter } from "./roster-recovery";

describe("RosterRecoveryArbiter", () => {
  it("defers automatic rescue while a signed-session generation settles", () => {
    const arbiter = new RosterRecoveryArbiter();
    arbiter.beginSession("vixsrc-luna");

    expect(arbiter.requestAutomatic()).toBe("defer");
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("allows the one title rescue only after session ownership ends", () => {
    const arbiter = new RosterRecoveryArbiter();
    arbiter.beginSession("vixsrc-luna");
    expect(arbiter.requestAutomatic()).toBe("defer");

    expect(arbiter.endSession("vixsrc-luna")).toBe(true);
    expect(arbiter.requestAutomatic()).toBe("start");
    expect(arbiter.requestAutomatic()).toBe("exhausted");
  });

  it("drops session ownership when recovery switches to a peer", () => {
    const arbiter = new RosterRecoveryArbiter();
    arbiter.beginSession("vixsrc-luna");
    arbiter.cancelSessionUnless("vidking-solstice");

    expect(arbiter.requestAutomatic()).toBe("start");
  });

  it("does not let a stale generation end the current session owner", () => {
    const arbiter = new RosterRecoveryArbiter();
    arbiter.beginSession("vixsrc-luna");

    expect(arbiter.endSession("old-source")).toBe(false);
    expect(arbiter.requestAutomatic()).toBe("defer");
  });

  it("resets both layers on title identity change", () => {
    const arbiter = new RosterRecoveryArbiter();
    expect(arbiter.requestAutomatic()).toBe("start");
    arbiter.beginSession("vixsrc-luna");

    arbiter.reset();
    expect(arbiter.requestAutomatic()).toBe("start");
  });
});
