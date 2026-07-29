export type MediaPauseDisposition = "internal" | "native-user" | "ambient";

/**
 * Native PiP controls and engine teardown both emit uncommanded media pause
 * events. Tag teardown before pause() so it cannot overwrite user intent.
 */
export class MediaPauseIntentController {
  private pendingInternalPauses = 0;

  expectInternalPause(): void {
    this.pendingInternalPauses += 1;
  }

  consumePause(inPictureInPicture: boolean): MediaPauseDisposition {
    if (this.pendingInternalPauses > 0) {
      this.pendingInternalPauses -= 1;
      return "internal";
    }
    return inPictureInPicture ? "native-user" : "ambient";
  }
}
