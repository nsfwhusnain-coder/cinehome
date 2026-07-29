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

  it("fails a silent stall immediately when the media path has no recovery engine", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("progressive-mp4");

    expect(controller.noteSilentStall(attempt, false)).toBe("terminal");
  });

  it("resets the stall budget when the playhead advances", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("source-a");

    expect(controller.noteSilentStall(attempt)).toBe("recover");
    controller.noteProgress(attempt);
    expect(controller.noteSilentStall(attempt)).toBe("recover");
  });

  it("single-flights a signed-url refresh and suppresses competing failures", () => {
    const controller = new SourceAttemptController();
    const attempt = controller.begin("signed-source");

    expect(controller.requestRefresh(attempt)).toBe("started");
    expect(controller.requestRefresh(attempt)).toBe("pending");
    expect(controller.noteHardTransportFailure(attempt)).toBe("ignored");
    expect(controller.noteSilentStall(attempt)).toBe("ignored");
    expect(controller.claimTerminal(attempt)).toBe(false);
  });

  it("allows terminal handling only after the active refresh explicitly ends", () => {
    const controller = new SourceAttemptController(1);
    const attempt = controller.begin("signed-source");

    expect(controller.requestRefresh(attempt)).toBe("started");
    expect(controller.finishRefresh(attempt)).toBe(true);
    expect(controller.finishRefresh(attempt)).toBe(false);
    expect(controller.noteHardTransportFailure(attempt)).toBe("terminal");
    expect(controller.claimTerminal(attempt)).toBe(true);
  });

  it("ignores refresh completion from a superseded generation", () => {
    const controller = new SourceAttemptController();
    const oldAttempt = controller.begin("signed-source");
    expect(controller.requestRefresh(oldAttempt)).toBe("started");
    const currentAttempt = controller.begin("signed-source");

    expect(controller.finishRefresh(oldAttempt)).toBe(false);
    expect(controller.requestRefresh(oldAttempt)).toBe("ignored");
    expect(controller.requestRefresh(currentAttempt)).toBe("exhausted");
  });

  it("bounds repeated signed-url refreshes across replacement generations", () => {
    const controller = new SourceAttemptController();
    const expiredAttempt = controller.begin("signed-source");

    expect(controller.requestRefresh(expiredAttempt)).toBe("started");
    const stillExpiredAttempt = controller.begin("signed-source");

    expect(controller.requestRefresh(stillExpiredAttempt)).toBe("exhausted");
    expect(controller.claimTerminal(stillExpiredAttempt)).toBe(true);
  });

  it("reopens the refresh budget only after measured healthy playback", () => {
    const controller = new SourceAttemptController();
    const expiredAttempt = controller.begin("signed-source");
    expect(controller.requestRefresh(expiredAttempt)).toBe("started");

    const recoveredAttempt = controller.begin("signed-source");
    controller.noteProgress(recoveredAttempt);
    expect(controller.requestRefresh(recoveredAttempt)).toBe("exhausted");

    controller.noteHealthyPlayback(recoveredAttempt);
    expect(controller.requestRefresh(recoveredAttempt)).toBe("started");
  });

  it("keeps refresh budgets independent across peer sources", () => {
    const controller = new SourceAttemptController();
    const sourceA = controller.begin("source-a");
    expect(controller.requestRefresh(sourceA)).toBe("started");
    const sourceAReplacement = controller.begin("source-a");
    expect(controller.requestRefresh(sourceAReplacement)).toBe("exhausted");

    const sourceB = controller.begin("source-b");
    expect(controller.requestRefresh(sourceB)).toBe("started");
  });

  it("clears cross-title refresh history explicitly", () => {
    const controller = new SourceAttemptController();
    const oldTitle = controller.begin("provider-stable-id");
    expect(controller.requestRefresh(oldTitle)).toBe("started");

    controller.resetRefreshBudget();
    const newTitle = controller.begin("provider-stable-id");
    expect(controller.requestRefresh(newTitle)).toBe("started");
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
