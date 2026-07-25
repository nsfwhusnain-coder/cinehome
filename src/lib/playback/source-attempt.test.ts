import { describe, expect, it } from "bun:test";
import { SourceAttemptController } from "./source-attempt";

describe("SourceAttemptController", () => {
  it("ignores callbacks from a superseded source generation", () => {
    const controller = new SourceAttemptController();
    const oldAttempt = controller.begin("source-a");
    const currentAttempt = controller.begin("source-b");

    expect(controller.noteHardTransportFailure(oldAttempt)).toBe("ignored");
    expect(controller.noteSilentStall(oldAttempt)).toBe("ignored");
    expect(controller.claimTerminal(oldAttempt)).toBe(false);
    expect(controller.isCurrent(currentAttempt)).toBe(true);
  });

  it("fails after two hard transport errors without progress", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    expect(controller.noteHardTransportFailure(attempt)).toBe("retry");
    expect(controller.noteHardTransportFailure(attempt)).toBe("terminal");
    expect(controller.claimTerminal(attempt)).toBe(true);
    expect(controller.claimTerminal(attempt)).toBe(false);
  });

  it("clears transient transport strikes after playback progresses", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    expect(controller.noteHardTransportFailure(attempt)).toBe("retry");
    controller.noteProgress(attempt);
    expect(controller.noteHardTransportFailure(attempt)).toBe("retry");
  });

  it("allows one stall recovery window and then fails over", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    expect(controller.noteSilentStall(attempt)).toBe("recover");
    expect(controller.noteSilentStall(attempt)).toBe("terminal");
  });

  it("resets the stall budget when the playhead advances", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    expect(controller.noteSilentStall(attempt)).toBe("recover");
    controller.noteProgress(attempt);
    expect(controller.noteSilentStall(attempt)).toBe("recover");
  });

  it("invalidates before teardown so abort callbacks cannot claim failure", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    controller.invalidate(attempt);

    expect(controller.noteHardTransportFailure(attempt)).toBe("ignored");
    expect(controller.claimTerminal(attempt)).toBe(false);
    expect(controller.currentToken()).toBeNull();
  });
});
