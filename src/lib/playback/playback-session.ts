export type PlaybackPhase =
  | "idle"
  | "attaching"
  | "playing"
  | "rebuffering"
  | "failing"
  | "switching";

export type PlaybackSessionEvent =
  | { type: "roster_ready" }
  | { type: "attach" }
  | { type: "first_frame" }
  | { type: "waiting" }
  | { type: "playing" }
  | { type: "source_failed" }
  | { type: "user_switch" }
  | { type: "reset" };

const TRANSITIONS: Record<PlaybackPhase, Partial<Record<PlaybackSessionEvent["type"], PlaybackPhase>>> =
  {
    idle: { roster_ready: "attaching", attach: "attaching", reset: "idle" },
    attaching: {
      first_frame: "playing",
      source_failed: "failing",
      user_switch: "switching",
      reset: "idle",
    },
    playing: {
      waiting: "rebuffering",
      source_failed: "failing",
      user_switch: "switching",
      attach: "switching",
      reset: "idle",
    },
    rebuffering: {
      playing: "playing",
      first_frame: "playing",
      source_failed: "failing",
      user_switch: "switching",
      reset: "idle",
    },
    failing: {
      attach: "attaching",
      roster_ready: "attaching",
      user_switch: "switching",
      reset: "idle",
    },
    switching: {
      attach: "attaching",
      first_frame: "playing",
      source_failed: "failing",
      reset: "idle",
    },
  };

export function reducePlaybackPhase(
  phase: PlaybackPhase,
  event: PlaybackSessionEvent
): PlaybackPhase {
  return TRANSITIONS[phase][event.type] ?? phase;
}

export function isPlaybackStickyPhase(phase: PlaybackPhase): boolean {
  return phase === "playing" || phase === "rebuffering";
}
