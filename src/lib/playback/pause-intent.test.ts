import { describe, expect, it } from "bun:test";
import { MediaPauseIntentController } from "./pause-intent";

describe("MediaPauseIntentController", () => {
  it("does not turn a PiP engine teardown into user pause intent", () => {
    const controller = new MediaPauseIntentController();
    controller.expectInternalPause();

    expect(controller.consumePause(true)).toBe("internal");
  });

  it("classifies an untagged native PiP pause as user intent", () => {
    const controller = new MediaPauseIntentController();

    expect(controller.consumePause(true)).toBe("native-user");
  });

  it("consumes only the tagged teardown pause", () => {
    const controller = new MediaPauseIntentController();
    controller.expectInternalPause();

    expect(controller.consumePause(true)).toBe("internal");
    expect(controller.consumePause(true)).toBe("native-user");
    expect(controller.consumePause(false)).toBe("ambient");
  });

  it("tracks back-to-back internal teardowns independently", () => {
    const controller = new MediaPauseIntentController();
    controller.expectInternalPause();
    controller.expectInternalPause();

    expect(controller.consumePause(false)).toBe("internal");
    expect(controller.consumePause(true)).toBe("internal");
    expect(controller.consumePause(true)).toBe("native-user");
  });
});
